import type { Dirent } from 'node:fs'
import { createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

/** ENOENT is a value, never an exception — `.agents/denials.log` legitimately
 *  does not exist, and callers must distinguish "no config" from "unreadable
 *  config". */
export type FileFailureKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io'

export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: FileFailureKind; readonly message: string }

/** Keeps a runaway denials log from OOM-ing the main process; streaming
 *  support for tailing large logs is out of scope and extends this module
 *  when it lands. */
const MAX_BYTES = 16 * 1024 * 1024

interface ErrnoLike {
  readonly code?: string
  readonly message?: string
}

function classifyFsError(error: unknown): { kind: FileFailureKind; message: string } {
  const err = error as ErrnoLike
  const message = err.message ?? String(error)
  switch (err.code) {
    case 'ENOENT':
      return { kind: 'not-found', message }
    case 'EACCES':
      return { kind: 'permission-denied', message }
    case 'EISDIR':
    case 'ENOTDIR':
      return { kind: 'not-a-file', message }
    default:
      return { kind: 'io', message }
  }
}

async function checkSize(path: string): Promise<{ ok: true } | { ok: false; kind: FileFailureKind; message: string }> {
  try {
    const info = await stat(path)
    if (info.size > MAX_BYTES) {
      return { ok: false, kind: 'too-large', message: `${path} exceeds the ${MAX_BYTES}-byte cap` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

export async function readTextFile(path: string): Promise<FileResult<string>> {
  const sizeCheck = await checkSize(path)
  if (!sizeCheck.ok) return sizeCheck
  try {
    const value = await readFile(path, 'utf8')
    return { ok: true, value }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

export async function readJsonFile<T>(path: string): Promise<FileResult<T>> {
  const text = await readTextFile(path)
  if (!text.ok) return text
  try {
    return { ok: true, value: JSON.parse(text.value) as T }
  } catch (error) {
    return { ok: false, kind: 'unparseable', message: error instanceof Error ? error.message : String(error) }
  }
}

export type DirEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface DirEntry {
  readonly name: string
  readonly kind: DirEntryKind
}

function classifyDirent(entry: Dirent): DirEntryKind {
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isFile()) return 'file'
  return 'other'
}

export async function listDirectory(path: string): Promise<FileResult<readonly DirEntry[]>> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return { ok: true, value: entries.map((entry) => ({ name: entry.name, kind: classifyDirent(entry) })) }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

export interface StatInfo {
  readonly kind: 'file' | 'directory' | 'other'
  readonly size: number
  readonly modifiedAt: string
}

/** `modifiedAt` (`info.mtime.toISOString()`) is the only per-agent activity
 *  source a local read can produce (#78) — a transcript's own mtime, read
 *  beside its `meta.json`. `main/platform/` is the only place under `src/`
 *  allowed to reach `node:fs`, so every activity signal in the app comes
 *  through here rather than a second `stat` call elsewhere. */
export async function statPath(path: string): Promise<FileResult<StatInfo>> {
  try {
    const info = await stat(path)
    const kind: StatInfo['kind'] = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    return { ok: true, value: { kind, size: info.size, modifiedAt: info.mtime.toISOString() } }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

/** Creates `path` and every missing parent, succeeding silently when it
 *  already exists — the registry's userData directory may or may not exist
 *  on first launch, and both cases are the same "make sure it's there". */
export async function ensureDirectory(path: string): Promise<FileResult<void>> {
  try {
    await mkdir(path, { recursive: true })
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

export interface ReadLinesOptions {
  readonly maxBytes: number
}

export type ReadLinesResult = { readonly ok: true } | { readonly ok: false; readonly kind: FileFailureKind; readonly message: string }

/** Streams `path` line by line — `crlfDelay: Infinity` so a CRLF transcript
 *  written on Windows yields the same lines a LF one would — calling
 *  `onLine` for each, and aborts with `too-large` the moment the raw byte
 *  count (measured off the stream's own chunks, never the line-split text)
 *  passes `maxBytes`. Streaming rather than a pre-`stat` because a live
 *  agent's transcript can grow between the stat and the read; the caller
 *  still wants the file's current size separately (`statPath`), not derived
 *  from this count. */
export async function readLines(path: string, onLine: (line: string) => void, options: ReadLinesOptions): Promise<ReadLinesResult> {
  return new Promise((resolve) => {
    let settled = false
    let bytes = 0

    const stream = createReadStream(path, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    function finish(result: ReadLinesResult): void {
      if (settled) return
      settled = true
      rl.close()
      if (!stream.destroyed) stream.destroy()
      resolve(result)
    }

    stream.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > options.maxBytes) {
        finish({ ok: false, kind: 'too-large', message: `${path} exceeds the ${options.maxBytes}-byte cap` })
      }
    })
    stream.on('error', (error) => {
      finish({ ok: false, ...classifyFsError(error) })
    })
    // `readline.Interface` re-emits its input stream's `error` as its own —
    // an `error` event with no listener throws, so without this, the stream
    // listener above still runs (settling the promise correctly) but the
    // interface's own unheard `error` event crashes the process right after.
    rl.on('error', (error) => {
      finish({ ok: false, ...classifyFsError(error) })
    })
    rl.on('line', (line) => {
      if (settled) return
      onLine(line)
    })
    rl.on('close', () => {
      finish({ ok: true })
    })
  })
}

/** Writes `value` as JSON to `path` without ever leaving a half-written file
 *  behind: serialize first (a circular value throws before anything touches
 *  disk), write a uuid-suffixed temp file beside the target, then `rename`
 *  over it — `rename` replaces an existing file atomically on POSIX and on
 *  Windows alike, unlike a plain `writeFile` to the target path. The temp
 *  file is written in the target's own directory so the rename never crosses
 *  a filesystem boundary, and a best-effort unlink cleans it up on failure. */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<FileResult<void>> {
  const text = JSON.stringify(value, null, 2)
  const tempPath = join(dirname(path), `${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, text, 'utf8')
    await rename(tempPath, path)
    return { ok: true, value: undefined }
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // Best-effort only — the temp file may never have been created.
    }
    return { ok: false, ...classifyFsError(error) }
  }
}

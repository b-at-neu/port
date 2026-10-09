import type { Dirent } from 'node:fs'
import { createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** ENOENT is a value, never an exception — callers must distinguish "no config" from "unreadable". */
export type FileFailureKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io'

export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: FileFailureKind; readonly message: string }

// Keeps a runaway denials log from OOM-ing the main process.
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

// `main/platform/` is the only place under `src/` allowed to reach `node:fs`.
export async function statPath(path: string): Promise<FileResult<StatInfo>> {
  try {
    const info = await stat(path)
    const kind: StatInfo['kind'] = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    return { ok: true, value: { kind, size: info.size, modifiedAt: info.mtime.toISOString() } }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

/** Succeeds silently when `path` already exists — both cases are "make sure it's there". */
export async function ensureDirectory(path: string): Promise<FileResult<void>> {
  try {
    await mkdir(path, { recursive: true })
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

export interface ReadLinesFromOptions {
  readonly maxBytes: number
}

export interface ReadLinesFromValue {
  readonly lines: readonly string[]
  /** The caller's next `start`. A partial trailing line is never counted here, so a resumed read picks it up whole. */
  readonly bytesConsumed: number
  /** The only honest "there may be more past this window" signal; `nextOffset < size` is not one. */
  readonly filledBudget: boolean
}

export type ReadLinesFromResult = FileResult<ReadLinesFromValue>

/** Finds the **last** newline in the window and decodes only the bytes before it, so a multi-byte
 *  sequence is never split. A full window with no newline reports `too-large` instead of spinning. */
export async function readLinesFrom(path: string, start: number, options: ReadLinesFromOptions): Promise<ReadLinesFromResult> {
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    let bytesRead = 0

    const stream = createReadStream(path, { start, end: start + options.maxBytes - 1 })

    function finish(result: ReadLinesFromResult): void {
      if (settled) return
      settled = true
      if (!stream.destroyed) stream.destroy()
      resolve(result)
    }

    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      bytesRead += chunk.length
    })
    stream.on('error', (error) => {
      finish({ ok: false, ...classifyFsError(error) })
    })
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const lastNewline = buffer.lastIndexOf(0x0a)
      const filledBudget = bytesRead === options.maxBytes

      if (lastNewline === -1) {
        if (filledBudget) {
          finish({ ok: false, kind: 'too-large', message: `${path} has no newline within ${options.maxBytes} bytes of offset ${start}` })
          return
        }
        finish({ ok: true, value: { lines: [], bytesConsumed: 0, filledBudget } })
        return
      }

      const text = buffer.subarray(0, lastNewline).toString('utf8')
      const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      finish({ ok: true, value: { lines, bytesConsumed: lastNewline + 1, filledBudget } })
    })
  })
}

/** The plain (non-atomic) counterpart to `writeJsonFileAtomic`. */
export async function writeTextFile(path: string, text: string): Promise<FileResult<void>> {
  try {
    await writeFile(path, text, 'utf8')
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

// The only way anything under `src/` may grow a file line by line.
export async function appendTextFile(path: string, text: string): Promise<FileResult<void>> {
  try {
    await appendFile(path, text, 'utf8')
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

/** Reports `not-found` rather than throwing when `path` is already gone — the caller's intent
 *  is already satisfied. */
export async function removeFile(path: string): Promise<FileResult<void>> {
  try {
    await unlink(path)
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

/** Replaces an existing file at `to` atomically on POSIX and on Windows alike. */
export async function renamePath(from: string, to: string): Promise<FileResult<void>> {
  try {
    await rename(from, to)
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

/** Writes a uuid-suffixed temp file beside the target, then renames over it, so a half-written
 *  file never lands at `path`, and the rename never crosses a filesystem boundary. */
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

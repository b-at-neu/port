import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'

/** ENOENT is a value, never an exception — `.agents/denials.log` legitimately
 *  does not exist, and #74 must distinguish "no config" from "unreadable
 *  config". */
export type FileFailureKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io'

export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: FileFailureKind; readonly message: string }

/** Keeps a runaway denials log from OOM-ing the main process; streaming for
 *  #84's tailing is out of scope and extends this module when it lands. */
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
}

export async function statPath(path: string): Promise<FileResult<StatInfo>> {
  try {
    const info = await stat(path)
    const kind: StatInfo['kind'] = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    return { ok: true, value: { kind, size: info.size } }
  } catch (error) {
    return { ok: false, ...classifyFsError(error) }
  }
}

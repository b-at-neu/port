import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirectorySizeResult } from '@/types/platform'

const DEFAULT_MAX_ENTRIES = 200_000

interface DirectorySizeOptions {
  readonly maxEntries?: number
}

interface ErrnoLike {
  readonly code?: string
  readonly message?: string
}

/** Never follows a symlink. Stops at `maxEntries`, and counts an unreadable subdirectory as truncation, so the total is never an undercount presented as exact. */
export async function directorySize(path: string, options: DirectorySizeOptions = {}): Promise<DirectorySizeResult> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  let root: Stats
  try {
    root = await lstat(path)
  } catch (error) {
    const err = error as ErrnoLike
    return { ok: false, kind: err.code === 'ENOENT' ? 'not-found' : 'io', message: err.message ?? String(error) }
  }

  let bytes = root.isDirectory() ? 0 : root.size
  let entries = 0
  let truncated = false
  const pending: string[] = root.isDirectory() ? [path] : []

  while (pending.length > 0 && !truncated) {
    const directory = pending.pop() as string
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      truncated = true
      break
    }
    for (const name of names) {
      if (entries >= maxEntries) {
        truncated = true
        break
      }
      entries += 1
      const child = join(directory, name)
      try {
        const info = await lstat(child)
        if (info.isDirectory()) pending.push(child)
        else bytes += info.size
      } catch {
        truncated = true
      }
    }
  }

  return { ok: true, bytes, entries, truncated }
}

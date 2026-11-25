import type { z } from 'zod'
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import type { FileResult } from '@/types/platform'

export interface StoreFs {
  readonly readJson: (path: string) => Promise<FileResult<unknown>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  /** Omitted when the directory is known to exist. */
  readonly ensureDir?: (path: string) => Promise<FileResult<void>>
}

export const nodeStoreFs: StoreFs = { readJson: readJsonFile<unknown>, writeJsonAtomic: writeJsonFileAtomic, ensureDir: ensureDirectory }

export type UnreadableReason = 'malformed' | 'newer-version' | 'io'

export type StoreStatus =
  | { readonly kind: 'loaded' }
  | { readonly kind: 'unreadable'; readonly reason: UnreadableReason; readonly message: string; readonly path: string }

export type StoreWriteResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'refused' | 'io'; readonly message: string }

export interface JsonStoreOptions<T, Env> {
  readonly file: string
  /** `null` marks a file shared with another tool: no version key is written and no version gate runs. */
  readonly version: number | null
  /** Covers the whole file at the current version. */
  readonly schema: z.ZodType<T>
  /** Lifts a raw file at `fromVersion` to the current version, a pure function of `raw` and the `env` the caller passed to `load`. `null` defers the migration: the store loads `initial` and the old file stays untouched. */
  readonly migrate?: (fromVersion: number, raw: unknown, env: Env) => unknown
  readonly initial: T
  /** `read-only` never overwrites a file this build could not read; `reset` lets the next write replace it. */
  readonly unreadable: 'read-only' | 'reset'
  readonly fs?: StoreFs
}

/** `written` is true only when a migrated file was written back; the old file is still the one on disk otherwise. */
export interface LoadResult {
  readonly migrated: boolean
  readonly written: boolean
}

const UNMIGRATED: LoadResult = { migrated: false, written: false }

export interface JsonStore<T, Env = void> {
  readonly load: (env?: Env) => Promise<LoadResult>
  readonly value: () => T
  readonly status: () => StoreStatus
  readonly write: (next: T) => Promise<StoreWriteResult>
  readonly update: (fn: (current: T) => T) => Promise<StoreWriteResult>
}

function versionOf(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const version = (raw as { version?: unknown }).version
  return typeof version === 'number' && Number.isInteger(version) ? version : null
}

export function createJsonStore<T, Env = void>(options: JsonStoreOptions<T, Env>): JsonStore<T, Env> {
  const fs = options.fs ?? nodeStoreFs
  let current = options.initial
  let state: StoreStatus = { kind: 'loaded' }
  let tail: Promise<void> | null = null

  function unreadable(reason: UnreadableReason, message: string): LoadResult {
    current = options.initial
    state = { kind: 'unreadable', reason, message, path: options.file }
    return UNMIGRATED
  }

  async function persist(next: T): Promise<StoreWriteResult> {
    if (state.kind === 'unreadable' && options.unreadable === 'read-only') {
      return { ok: false, kind: 'refused', message: `${options.file} could not be read, so it is never overwritten: ${state.message}` }
    }
    if (fs.ensureDir !== undefined) {
      const ensured = await fs.ensureDir(pathOps.dirname(options.file))
      if (!ensured.ok) return { ok: false, kind: 'io', message: ensured.message }
    }
    const written = await fs.writeJsonAtomic(options.file, next)
    if (!written.ok) return { ok: false, kind: 'io', message: written.message }
    current = next
    state = { kind: 'loaded' }
    return { ok: true }
  }

  function serialized<R>(task: () => Promise<R>): Promise<R> {
    const run = tail === null ? task() : tail.then(task)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    tail = settled
    void settled.then(() => {
      if (tail === settled) tail = null
    })
    return run
  }

  async function load(env?: Env): Promise<LoadResult> {
    const read = await fs.readJson(options.file)
    if (!read.ok) {
      if (read.kind === 'not-found') {
        current = options.initial
        state = { kind: 'loaded' }
        return UNMIGRATED
      }
      unreadable(read.kind === 'unparseable' ? 'malformed' : 'io', read.message)
      return UNMIGRATED
    }

    let raw = read.value
    let migrated = false
    if (options.version !== null) {
      const found = versionOf(raw)
      if (found === null) return unreadable('malformed', `${options.file} has no version`)
      if (found > options.version) return unreadable('newer-version', `${options.file} was written by a newer version of Port (version ${String(found)})`)
      if (found < options.version) {
        if (options.migrate === undefined) return unreadable('malformed', `${options.file} is at version ${String(found)} and no migration exists`)
        try {
          raw = options.migrate(found, raw, env as Env)
        } catch (error) {
          return unreadable('malformed', error instanceof Error ? error.message : String(error))
        }
        if (raw === null) {
          current = options.initial
          state = { kind: 'loaded' }
          return UNMIGRATED
        }
        migrated = true
      }
    }

    const parsed = options.schema.safeParse(raw)
    if (!parsed.success) return unreadable('malformed', `${options.file} is not valid: ${parsed.error.message}`)

    current = parsed.data
    state = { kind: 'loaded' }
    if (!migrated) return UNMIGRATED
    const written = await fs.writeJsonAtomic(options.file, parsed.data)
    if (!written.ok) console.error(`${options.file}: the migrated file could not be written back, so the old file stays on disk: ${written.message}`)
    return { migrated: true, written: written.ok }
  }

  return {
    load,
    value: () => current,
    status: () => state,
    write: (next) => serialized(() => persist(next)),
    update: (fn) => serialized(() => persist(fn(current))),
  }
}

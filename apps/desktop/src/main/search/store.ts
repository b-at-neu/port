// The persisted signature manifest (#87), beside `registry.json` in
// userData -- same shape as `main/registry/store.ts`: takes its directory as
// a parameter so nothing here imports Electron, and every test passes a
// `mkdtemp`.
import { ensureDirectory, pathOps, readJsonFile, writeJsonFileAtomic } from '../platform'

const SEARCH_INDEX_FILE = 'search-index.json'
const CURRENT_VERSION = 1

/** Keyed by `sessionId` or `sessionId#agentId` in the caller's own map --
 *  this module only ever sees the key as an opaque string. */
export interface SignatureIndexEntry {
  readonly path: string
  readonly sizeBytes: number
  readonly modifiedAt: string
  readonly bits: number
  readonly signature: string
}

export type SignatureIndex = ReadonlyMap<string, SignatureIndexEntry>

interface SignatureIndexFileShape {
  readonly version: number
  readonly entries: Record<string, SignatureIndexEntry>
}

function indexPath(dir: string): string {
  return pathOps.join(dir, SEARCH_INDEX_FILE)
}

function isValidEntry(value: unknown): value is SignatureIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['path'] === 'string' && typeof v['sizeBytes'] === 'number' && typeof v['modifiedAt'] === 'string' && typeof v['bits'] === 'number' && typeof v['signature'] === 'string'
}

/**
 * Unlike the registry, a bad index file is **discarded, not refused** — it
 * holds nothing an operator authored, so the cost of losing it is one slow
 * search, whereas refusing to write (the registry's own rule) would make
 * every future search slow forever for a recovery this file cannot even
 * offer. Absent, unparseable, malformed, or a newer `version` all mean
 * "start empty" here; an individual entry that fails shape validation is
 * dropped on its own, since the surrounding JSON was still valid.
 */
export async function readSignatureIndex(dir: string): Promise<SignatureIndex> {
  const result = await readJsonFile<SignatureIndexFileShape>(indexPath(dir))
  if (!result.ok) return new Map()

  const value = result.value
  if (typeof value !== 'object' || value === null || typeof value.entries !== 'object' || value.entries === null) return new Map()
  if (typeof value.version !== 'number' || value.version > CURRENT_VERSION) return new Map()

  const index = new Map<string, SignatureIndexEntry>()
  for (const [key, entry] of Object.entries(value.entries)) {
    if (isValidEntry(entry)) index.set(key, entry)
  }
  return index
}

export type WriteSignatureIndexResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

export async function writeSignatureIndex(dir: string, index: SignatureIndex): Promise<WriteSignatureIndexResult> {
  const ensured = await ensureDirectory(dir)
  if (!ensured.ok) return { ok: false, message: ensured.message }

  const entries: Record<string, SignatureIndexEntry> = {}
  for (const [key, entry] of index) entries[key] = entry
  const value: SignatureIndexFileShape = { version: CURRENT_VERSION, entries }
  const written = await writeJsonFileAtomic(indexPath(dir), value)
  if (!written.ok) return { ok: false, message: written.message }
  return { ok: true }
}

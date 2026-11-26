// Takes its directory as a parameter so nothing here imports Electron; every test passes a `mkdtemp`.
// `reset`: a bad index file is discarded and replaced by the next write — it holds nothing an operator authored, so the cost of losing it is one slow search.
import { z } from 'zod'
import { createJsonStore } from '@/main/platform/json-store'
import type { StoreFs } from '@/main/platform/json-store'
import { pathOps } from '@/main/platform/paths'
import type { SignatureIndexEntry } from '@/types/search'

const SEARCH_INDEX_FILE = 'search-index.json'
const CURRENT_VERSION = 1

type SignatureIndex = ReadonlyMap<string, SignatureIndexEntry>

const indexSchema = z.object({ version: z.literal(CURRENT_VERSION), entries: z.record(z.string(), z.unknown()) })
const entrySchema = z.object({ path: z.string(), sizeBytes: z.number(), modifiedAt: z.string(), bits: z.number(), signature: z.string() })

function indexStore(fs: StoreFs, dir: string) {
  return createJsonStore({
    file: pathOps.join(dir, SEARCH_INDEX_FILE),
    version: CURRENT_VERSION,
    schema: indexSchema,
    initial: { version: CURRENT_VERSION, entries: {} },
    unreadable: 'reset',
    fs,
  })
}

export async function readSignatureIndex(fs: StoreFs, dir: string): Promise<SignatureIndex> {
  const store = indexStore(fs, dir)
  await store.load()
  const index = new Map<string, SignatureIndexEntry>()
  for (const [key, value] of Object.entries(store.value().entries)) {
    const entry = entrySchema.safeParse(value)
    if (entry.success) index.set(key, entry.data)
  }
  return index
}

type WriteSignatureIndexResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

export async function writeSignatureIndex(fs: StoreFs, dir: string, index: SignatureIndex): Promise<WriteSignatureIndexResult> {
  const written = await indexStore(fs, dir).write({ version: CURRENT_VERSION, entries: Object.fromEntries(index) })
  return written.ok ? { ok: true } : { ok: false, message: written.message }
}

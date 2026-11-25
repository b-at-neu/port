import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createJsonStore, type StoreFs } from '@/main/platform/json-store'
import type { FileResult } from '@/types/platform'

const FILE = '/data/thing.json'
const schema = z.strictObject({ version: z.literal(2), items: z.array(z.string()) })
type Thing = z.infer<typeof schema>
const initial: Thing = { version: 2, items: [] }

function memoryFs(files: Record<string, string>, failWrite = false): StoreFs & { readonly files: Record<string, string> } {
  return {
    files,
    readJson: (path): Promise<FileResult<unknown>> => {
      const text = files[path]
      if (text === undefined) return Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
      try {
        return Promise.resolve({ ok: true, value: JSON.parse(text) as unknown })
      } catch (error) {
        return Promise.resolve({ ok: false, kind: 'unparseable', message: String(error) })
      }
    },
    writeJsonAtomic: (path, value): Promise<FileResult<void>> => {
      if (failWrite) return Promise.resolve({ ok: false, kind: 'io', message: 'disk full' })
      files[path] = JSON.stringify(value)
      return Promise.resolve({ ok: true, value: undefined })
    },
    ensureDir: () => Promise.resolve({ ok: true, value: undefined }),
  }
}

function storeOver(fs: StoreFs, unreadable: 'read-only' | 'reset') {
  return createJsonStore<Thing, { readonly extra: string }>({
    file: FILE,
    version: 2,
    schema,
    initial,
    unreadable,
    fs,
    migrate: (from, raw, env) => {
      if (from !== 1) throw new Error(`no migration from ${String(from)}`)
      return { version: 2, items: [...(raw as { items: string[] }).items, env.extra] }
    },
  })
}

describe('createJsonStore load', () => {
  const cases: readonly { name: string; file: string | undefined; unreadable: 'read-only' | 'reset'; expected: { kind: string; reason?: string }; value: Thing }[] = [
    { name: 'a missing file loads the initial value', file: undefined, unreadable: 'read-only', expected: { kind: 'loaded' }, value: initial },
    { name: 'a current file loads as written', file: '{"version":2,"items":["a"]}', unreadable: 'read-only', expected: { kind: 'loaded' }, value: { version: 2, items: ['a'] } },
    { name: 'a parse failure is unreadable/malformed', file: '{oops', unreadable: 'read-only', expected: { kind: 'unreadable', reason: 'malformed' }, value: initial },
    { name: 'a schema failure is unreadable/malformed', file: '{"version":2,"items":"no"}', unreadable: 'read-only', expected: { kind: 'unreadable', reason: 'malformed' }, value: initial },
    { name: 'a newer version is unreadable/newer-version', file: '{"version":9,"items":[]}', unreadable: 'read-only', expected: { kind: 'unreadable', reason: 'newer-version' }, value: initial },
    { name: 'a file with no version is unreadable/malformed', file: '{"items":[]}', unreadable: 'reset', expected: { kind: 'unreadable', reason: 'malformed' }, value: initial },
  ]

  it.each(cases)('$name', async ({ file, unreadable, expected, value }) => {
    const store = storeOver(memoryFs(file === undefined ? {} : { [FILE]: file }), unreadable)
    await store.load({ extra: 'x' })
    expect(store.value()).toEqual(value)
    expect(store.status()).toMatchObject(expected)
  })

  it('migrates an older file with the caller env and writes it back once', async () => {
    const fs = memoryFs({ [FILE]: '{"version":1,"items":["a"]}' })
    const store = storeOver(fs, 'read-only')
    await store.load({ extra: 'x' })
    expect(store.value()).toEqual({ version: 2, items: ['a', 'x'] })
    expect(JSON.parse(fs.files[FILE] ?? '')).toEqual({ version: 2, items: ['a', 'x'] })
  })

  it('keeps the migrated value in memory and the old file when the write-back fails', async () => {
    const fs = memoryFs({ [FILE]: '{"version":1,"items":[]}' }, true)
    const store = storeOver(fs, 'read-only')
    await store.load({ extra: 'x' })
    expect(store.value().items).toEqual(['x'])
    expect(fs.files[FILE]).toBe('{"version":1,"items":[]}')
  })
})

describe('createJsonStore write', () => {
  it('a read-only store refuses to overwrite an unreadable file', async () => {
    const fs = memoryFs({ [FILE]: '{oops' })
    const store = storeOver(fs, 'read-only')
    await store.load({ extra: 'x' })
    expect(await store.write({ version: 2, items: ['a'] })).toMatchObject({ ok: false, kind: 'refused' })
    expect(fs.files[FILE]).toBe('{oops')
  })

  it('a reset store replaces an unreadable file and reports loaded', async () => {
    const fs = memoryFs({ [FILE]: '{oops' })
    const store = storeOver(fs, 'reset')
    await store.load({ extra: 'x' })
    expect(await store.write({ version: 2, items: ['a'] })).toEqual({ ok: true })
    expect(store.status()).toEqual({ kind: 'loaded' })
    expect(JSON.parse(fs.files[FILE] ?? '')).toEqual({ version: 2, items: ['a'] })
  })

  it('a failed write leaves the value unchanged', async () => {
    const store = storeOver(memoryFs({}, true), 'reset')
    await store.load({ extra: 'x' })
    expect(await store.update((current) => ({ ...current, items: ['a'] }))).toMatchObject({ ok: false, kind: 'io' })
    expect(store.value()).toEqual(initial)
  })

  it('serialises concurrent updates so none is lost', async () => {
    const store = storeOver(memoryFs({}), 'reset')
    await store.load({ extra: 'x' })
    await Promise.all(['a', 'b', 'c'].map((item) => store.update((current) => ({ ...current, items: [...current.items, item] }))))
    expect(store.value().items).toEqual(['a', 'b', 'c'])
  })

  it('a version:null store writes no version key and runs no version gate', async () => {
    const fs = memoryFs({ [FILE]: '{"owner":"app"}' })
    const store = createJsonStore({ file: FILE, version: null, schema: z.object({ owner: z.string() }), initial: { owner: 'none' }, unreadable: 'read-only', fs })
    await store.load()
    expect(store.value()).toEqual({ owner: 'app' })
    await store.write({ owner: 'repo' })
    expect(JSON.parse(fs.files[FILE] ?? '')).toEqual({ owner: 'repo' })
  })
})

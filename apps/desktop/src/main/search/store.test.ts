import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSignatureIndex, writeSignatureIndex } from './store'
import type { SignatureIndexEntry } from './store'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-search-store-'))
}

const ENTRY_A: SignatureIndexEntry = { path: '/a.jsonl', sizeBytes: 10, modifiedAt: '2026-01-01T00:00:00.000Z', bits: 1024, signature: 'AAAA' }

describe('readSignatureIndex', () => {
  it('returns an empty index when the file is absent', async () => {
    const dir = await makeTempDir()
    const index = await readSignatureIndex(dir)
    expect(index.size).toBe(0)
  })

  it('round-trips a written index', async () => {
    const dir = await makeTempDir()
    await writeSignatureIndex(dir, new Map([['s1', ENTRY_A]]))
    const index = await readSignatureIndex(dir)
    expect(index.get('s1')).toEqual(ENTRY_A)
  })

  it('discards (never throws on) unparseable JSON, and does not overwrite it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'search-index.json'), '{not json')
    const index = await readSignatureIndex(dir)
    expect(index.size).toBe(0)
  })

  it('discards a malformed file (no entries object)', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'search-index.json'), JSON.stringify({ version: 1 }))
    const index = await readSignatureIndex(dir)
    expect(index.size).toBe(0)
  })

  it('discards a file written by a newer version', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'search-index.json'), JSON.stringify({ version: 2, entries: { s1: ENTRY_A } }))
    const index = await readSignatureIndex(dir)
    expect(index.size).toBe(0)
  })

  it('drops one malformed entry without discarding the rest', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'search-index.json'), JSON.stringify({ version: 1, entries: { s1: ENTRY_A, s2: { path: '/b.jsonl' } } }))
    const index = await readSignatureIndex(dir)
    expect(index.size).toBe(1)
    expect(index.get('s1')).toEqual(ENTRY_A)
  })
})

describe('writeSignatureIndex', () => {
  it('creates the directory on first write', async () => {
    const parent = await makeTempDir()
    const dir = join(parent, 'nested', 'userData')
    const result = await writeSignatureIndex(dir, new Map([['s1', ENTRY_A]]))
    expect(result.ok).toBe(true)
    expect((await readSignatureIndex(dir)).get('s1')).toEqual(ENTRY_A)
  })

  it('overwrites a previously malformed file', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'search-index.json'), '{not json')
    const result = await writeSignatureIndex(dir, new Map([['s1', ENTRY_A]]))
    expect(result.ok).toBe(true)
    expect((await readSignatureIndex(dir)).get('s1')).toEqual(ENTRY_A)
  })
})

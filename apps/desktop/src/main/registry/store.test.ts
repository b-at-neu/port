import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPathOps } from '../platform/paths'
import { dedupePaths, readRegistry, writeRegistry } from './store'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-registry-store-'))
}

describe('readRegistry', () => {
  it('returns empty when the file is absent', async () => {
    const dir = await makeTempDir()
    expect(await readRegistry(dir)).toEqual({ ok: true, repositories: [] })
  })

  it('round-trips a written registry', async () => {
    const dir = await makeTempDir()
    await writeRegistry(dir, ['/a', '/b'])
    expect(await readRegistry(dir)).toEqual({ ok: true, repositories: ['/a', '/b'] })
  })

  it('reports registry-malformed for invalid JSON, and never overwrites it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'registry.json'), '{not json')
    const before = await readFile(join(dir, 'registry.json'), 'utf8')
    const result = await readRegistry(dir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('registry-malformed')
    const after = await readFile(join(dir, 'registry.json'), 'utf8')
    expect(after).toBe(before)
  })

  it('reports registry-unsupported-version for a newer version, and never overwrites it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'registry.json'), JSON.stringify({ version: 2, repositories: [{ path: '/a' }] }))
    const before = await readFile(join(dir, 'registry.json'), 'utf8')
    const result = await readRegistry(dir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('registry-unsupported-version')
    const after = await readFile(join(dir, 'registry.json'), 'utf8')
    expect(after).toBe(before)
  })
})

describe('writeRegistry', () => {
  it('creates the directory on first write', async () => {
    const parent = await makeTempDir()
    const dir = join(parent, 'nested', 'userData')
    const result = await writeRegistry(dir, ['/a'])
    expect(result.ok).toBe(true)
    expect(await readRegistry(dir)).toEqual({ ok: true, repositories: ['/a'] })
  })

  it('dedupes on write', async () => {
    const dir = await makeTempDir()
    await writeRegistry(dir, ['/a', '/a/', '/a'])
    expect(await readRegistry(dir)).toEqual({ ok: true, repositories: ['/a'] })
  })
})

describe('dedupePaths', () => {
  it('collapses a trailing separator [posix]', () => {
    const ops = createPathOps('posix', { home: '/home/u' })
    expect(dedupePaths(['/a/b', '/a/b/'], ops)).toEqual(['/a/b'])
  })

  it('collapses drive-letter case and separator differences [win32]', () => {
    const ops = createPathOps('win32', { home: 'C:\\Users\\u' })
    expect(dedupePaths(['C:\\Users\\u\\repo', 'c:/users/U/repo'], ops)).toEqual(['C:\\Users\\u\\repo'])
  })

  it('keeps genuinely distinct paths separate', () => {
    const ops = createPathOps('posix', { home: '/home/u' })
    expect(dedupePaths(['/a', '/b'], ops)).toEqual(['/a', '/b'])
  })
})

import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listDirectory, readJsonFile, readTextFile, statPath } from './files'

// Vitest runs each test's temp directory through the OS's own tmpdir
// cleanup; nothing here needs a teardown step.
async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-platform-files-'))
}

describe('readTextFile', () => {
  it('reads an existing file', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    const result = await readTextFile(file)
    expect(result).toEqual({ ok: true, value: 'hello' })
  })

  it('reports not-found for a missing file, never throwing', async () => {
    const dir = await makeTempDir()
    const result = await readTextFile(join(dir, 'missing.txt'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
  })

  it('reports not-a-file when reading a directory', async () => {
    const dir = await makeTempDir()
    const result = await readTextFile(dir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-a-file')
  })

  it('reports too-large past the cap', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'big.txt')
    await writeFile(file, 'x'.repeat(17 * 1024 * 1024))
    const result = await readTextFile(file)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('too-large')
    expect(typeof result.message).toBe('string')
  })
})

describe('readJsonFile', () => {
  it('parses valid JSON', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.json')
    await writeFile(file, '{"a":1}')
    const result = await readJsonFile<{ a: number }>(file)
    expect(result).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports unparseable on malformed JSON', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'bad.json')
    await writeFile(file, '{not json')
    const result = await readJsonFile(file)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('unparseable')
  })
})

describe('listDirectory', () => {
  it('lists mixed entry kinds', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'file.txt'), 'x')
    await mkdir(join(dir, 'sub'))
    await symlink(join(dir, 'file.txt'), join(dir, 'link.txt'))
    const result = await listDirectory(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const byName = new Map(result.value.map((entry) => [entry.name, entry.kind]))
    expect(byName.get('file.txt')).toBe('file')
    expect(byName.get('sub')).toBe('directory')
    expect(byName.get('link.txt')).toBe('symlink')
  })

  it('reports not-found for a missing directory', async () => {
    const dir = await makeTempDir()
    const result = await listDirectory(join(dir, 'missing'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
  })
})

describe('statPath', () => {
  it('reports the size and kind of a file', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    const result = await statPath(file)
    expect(result).toEqual({ ok: true, value: { kind: 'file', size: 5 } })
  })

  it('reports the kind of a directory', async () => {
    const dir = await makeTempDir()
    const result = await statPath(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.kind).toBe('directory')
  })
})

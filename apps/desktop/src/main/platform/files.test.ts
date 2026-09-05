import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { describe, expect, it } from 'vitest'
import { ensureDirectory, listDirectory, readJsonFile, readTextFile, statPath, writeJsonFileAtomic } from './files'

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

describe('ensureDirectory', () => {
  it('creates a missing directory, including missing parents', async () => {
    const dir = await makeTempDir()
    const target = join(dir, 'a', 'b', 'c')
    const result = await ensureDirectory(target)
    expect(result.ok).toBe(true)
    const stat = await statPath(target)
    expect(stat.ok).toBe(true)
    if (!stat.ok) throw new Error('unreachable')
    expect(stat.value.kind).toBe('directory')
  })

  it('succeeds silently when the directory already exists', async () => {
    const dir = await makeTempDir()
    const first = await ensureDirectory(dir)
    const second = await ensureDirectory(dir)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })
})

describe('writeJsonFileAtomic', () => {
  it('writes a first file, creating nothing extra', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'registry.json')
    const result = await writeJsonFileAtomic(file, { version: 1 })
    expect(result.ok).toBe(true)
    const readBack = await readJsonFile<{ version: number }>(file)
    expect(readBack).toEqual({ ok: true, value: { version: 1 } })
  })

  it('overwrites an existing file', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'registry.json')
    await writeJsonFileAtomic(file, { version: 1 })
    await writeJsonFileAtomic(file, { version: 2 })
    const readBack = await readJsonFile<{ version: number }>(file)
    expect(readBack).toEqual({ ok: true, value: { version: 2 } })
  })

  it('leaves no .tmp file behind on success', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'registry.json')
    await writeJsonFileAtomic(file, { version: 1 })
    const entries = await readdir(dir)
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves no .tmp file behind on a forced failure', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'missing-parent', 'registry.json')
    const result = await writeJsonFileAtomic(file, { version: 1 })
    expect(result.ok).toBe(false)
    const entries = await readdir(dir)
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('returns permission-denied when writing into an unwritable directory', async () => {
    if (platform === 'win32') return // chmod-based permission denial is not meaningful on Windows
    const dir = await makeTempDir()
    const locked = join(dir, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    try {
      const result = await writeJsonFileAtomic(join(locked, 'registry.json'), { version: 1 })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.kind).toBe('permission-denied')
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('round-trips a value read back byte-identical', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'registry.json')
    await writeJsonFileAtomic(file, { version: 1, repositories: [{ path: '/a' }] })
    const text = await readFile(file, 'utf8')
    expect(JSON.parse(text)).toEqual({ version: 1, repositories: [{ path: '/a' }] })
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

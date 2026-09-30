import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { describe, expect, it } from 'vitest'
import {
  appendTextFile,
  ensureDirectory,
  listDirectory,
  readJsonFile,
  readLinesFrom,
  readTextFile,
  removeFile,
  renamePath,
  statPath,
  writeJsonFileAtomic,
  writeTextFile,
} from './files'

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

describe('readLinesFrom', () => {
  it('yields every line of a normal LF file from offset 0', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\ntwo\nthree\n')
    const result = await readLinesFrom(file, 0, { maxBytes: 1024 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.lines).toEqual(['one', 'two', 'three'])
    expect(result.value.bytesConsumed).toBe('one\ntwo\nthree\n'.length)
    expect(result.value.filledBudget).toBe(false)
  })

  it('yields the same lines for a CRLF file as for the LF equivalent', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'crlf.jsonl')
    await writeFile(file, 'one\r\ntwo\r\nthree\r\n')
    const result = await readLinesFrom(file, 0, { maxBytes: 1024 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.lines).toEqual(['one', 'two', 'three'])
  })

  it('yields no lines for an empty file', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'empty.jsonl')
    await writeFile(file, '')
    const result = await readLinesFrom(file, 0, { maxBytes: 1024 })
    expect(result).toEqual({ ok: true, value: { lines: [], bytesConsumed: 0, filledBudget: false } })
  })

  it('leaves a partial trailing line unconsumed and uncounted', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'partial.jsonl')
    await writeFile(file, 'one\ntwo\nunterminated')
    const result = await readLinesFrom(file, 0, { maxBytes: 1024 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.lines).toEqual(['one', 'two'])
    expect(result.value.bytesConsumed).toBe('one\ntwo\n'.length)
  })

  it('resumes a read from the previous call\'s bytesConsumed', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'resume.jsonl')
    await writeFile(file, 'one\ntwo\n')
    const first = await readLinesFrom(file, 0, { maxBytes: 1024 })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    expect(first.value.lines).toEqual(['one', 'two'])

    await appendFile(file, 'three\n')
    const second = await readLinesFrom(file, first.value.bytesConsumed, { maxBytes: 1024 })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.value.lines).toEqual(['three'])
  })

  it('reports not-found for a missing file, never throwing', async () => {
    const dir = await makeTempDir()
    const result = await readLinesFrom(join(dir, 'missing.jsonl'), 0, { maxBytes: 1024 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
  })

  it('reads nothing past EOF — a value, not an error', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'short.jsonl')
    await writeFile(file, 'one\n')
    const result = await readLinesFrom(file, 100, { maxBytes: 1024 })
    expect(result).toEqual({ ok: true, value: { lines: [], bytesConsumed: 0, filledBudget: false } })
  })

  it('sets filledBudget when the window is exactly filled, so the caller knows to read again', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'chunked.jsonl')
    await writeFile(file, 'one\ntwo\nthree\nfour\n')
    const result = await readLinesFrom(file, 0, { maxBytes: 8 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.filledBudget).toBe(true)
  })

  it('reports too-large on a stuck line — one line longer than the whole budget, never spinning', async () => {
    // Large enough to arrive across many stream chunks (a small file can
    // arrive in one chunk, which would make an abort-mid-stream assertion
    // meaningless) — the same order-of-magnitude the readTextFile too-large
    // test above already uses for its own cap.
    const dir = await makeTempDir()
    const file = join(dir, 'big.jsonl')
    await writeFile(file, 'x'.repeat(4 * 1024 * 1024)) // one line, no newline at all
    const result = await readLinesFrom(file, 0, { maxBytes: 1024 * 1024 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('too-large')
  })
})

describe('writeTextFile', () => {
  it('creates a new file', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.txt')
    const result = await writeTextFile(file, 'hello')
    expect(result).toEqual({ ok: true, value: undefined })
    expect(await readFile(file, 'utf8')).toBe('hello')
  })

  it('overwrites an existing file whole', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'first and longer')
    await writeTextFile(file, 'second')
    expect(await readFile(file, 'utf8')).toBe('second')
  })

  it('reports not-found when the parent directory is missing', async () => {
    const dir = await makeTempDir()
    const result = await writeTextFile(join(dir, 'missing', 'a.txt'), 'x')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
  })
})

describe('appendTextFile', () => {
  it('creates a file that does not exist yet', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.jsonl')
    const result = await appendTextFile(file, 'one\n')
    expect(result).toEqual({ ok: true, value: undefined })
    expect(await readFile(file, 'utf8')).toBe('one\n')
  })

  it('appends to an existing file rather than overwriting it', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.jsonl')
    await appendTextFile(file, 'one\n')
    await appendTextFile(file, 'two\n')
    expect(await readFile(file, 'utf8')).toBe('one\ntwo\n')
  })

  it('reports not-found when the parent directory is missing', async () => {
    const dir = await makeTempDir()
    const result = await appendTextFile(join(dir, 'missing', 'a.jsonl'), 'x')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
  })
})

describe('removeFile', () => {
  it('deletes an existing file', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'x')
    const result = await removeFile(file)
    expect(result).toEqual({ ok: true, value: undefined })
    const entries = await readdir(dir)
    expect(entries).toEqual([])
  })

  it('reports not-found for a file that does not exist, never throwing', async () => {
    const dir = await makeTempDir()
    const result = await removeFile(join(dir, 'missing.txt'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
  })
})

describe('renamePath', () => {
  it('renames a file to a new path', async () => {
    const dir = await makeTempDir()
    const from = join(dir, 'a.txt')
    const to = join(dir, 'b.txt')
    await writeFile(from, 'hello')
    const result = await renamePath(from, to)
    expect(result).toEqual({ ok: true, value: undefined })
    expect(await readFile(to, 'utf8')).toBe('hello')
  })

  it('replaces an existing file at the destination', async () => {
    const dir = await makeTempDir()
    const from = join(dir, 'a.txt')
    const to = join(dir, 'b.txt')
    await writeFile(from, 'new')
    await writeFile(to, 'old')
    await renamePath(from, to)
    expect(await readFile(to, 'utf8')).toBe('new')
  })

  it('reports not-found when the source does not exist', async () => {
    const dir = await makeTempDir()
    const result = await renamePath(join(dir, 'missing.txt'), join(dir, 'b.txt'))
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
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.kind).toBe('file')
    expect(result.value.size).toBe(5)
  })

  it('reports the kind of a directory', async () => {
    const dir = await makeTempDir()
    const result = await statPath(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.kind).toBe('directory')
  })

  // #78: a transcript's mtime is the only per-agent activity signal a local
  // read can produce — the session adapter stat's a subagent's sibling
  // `.jsonl` for exactly this field.
  it('reports modifiedAt as the file mtime, ISO-formatted', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    const result = await statPath(file)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.modifiedAt).toBe(new Date(result.value.modifiedAt).toISOString())
  })
})

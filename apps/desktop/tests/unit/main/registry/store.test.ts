import { describe, expect, it } from 'vitest'
import { createPathOps, pathOps } from '@/main/platform/paths'
import { dedupePaths, readRegistry, writeRegistry } from '@/main/repos/registry-store'
import { createFakeFs } from '../../../support/fake-platform'

const DIR = pathOps.toNative('/userData')
const FILE = pathOps.join(DIR, 'registry.json')
const A = pathOps.toNative('/a')
const B = pathOps.toNative('/b')

const READ_CASES: readonly { readonly name: string; readonly file: string | null; readonly expected: unknown; readonly untouched: boolean }[] = [
  { name: 'a missing file reads as empty', file: null, expected: { ok: true, repositories: [] }, untouched: false },
  { name: 'a valid file lists its paths, deduped', file: JSON.stringify({ version: 1, repositories: [{ path: A }, { path: `${A}/` }, { path: B }] }), expected: { ok: true, repositories: [A, B] }, untouched: false },
  { name: 'invalid JSON is malformed and never overwritten', file: '{not json', expected: { ok: false, kind: 'registry-malformed' }, untouched: true },
  { name: 'a newer version is unsupported and never overwritten', file: JSON.stringify({ version: 2, repositories: [{ path: '/a' }] }), expected: { ok: false, kind: 'registry-unsupported-version' }, untouched: true },
]

describe('readRegistry', () => {
  it.each(READ_CASES)('$name', async ({ file, expected, untouched }) => {
    const fs = createFakeFs()
    if (file !== null) await fs.writeText(FILE, file)

    expect(await readRegistry({ fs }, DIR)).toMatchObject(expected as object)
    if (untouched) expect(await fs.readText(FILE)).toEqual({ ok: true, value: file })
  })
})

describe('writeRegistry', () => {
  it('round-trips and dedupes what it writes', async () => {
    const fs = createFakeFs()
    expect((await writeRegistry({ fs }, DIR, [A, `${A}/`, B])).ok).toBe(true)
    expect(await readRegistry({ fs }, DIR)).toEqual({ ok: true, repositories: [A, B] })
  })
})

describe('dedupePaths', () => {
  it.each([
    { name: 'a trailing separator [posix]', ops: createPathOps('posix', { home: '/home/u' }), paths: ['/a/b', '/a/b/'], expected: ['/a/b'] },
    { name: 'drive-letter case and separators [win32]', ops: createPathOps('win32', { home: 'C:\\Users\\u' }), paths: ['C:\\Users\\u\\repo', 'c:/users/U/repo'], expected: ['C:\\Users\\u\\repo'] },
    { name: 'genuinely distinct paths stay separate', ops: createPathOps('posix', { home: '/home/u' }), paths: ['/a', '/b'], expected: ['/a', '/b'] },
  ])('collapses $name', ({ ops, paths, expected }) => {
    expect(dedupePaths(paths, ops)).toEqual(expected)
  })
})

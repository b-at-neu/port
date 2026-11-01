import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { directorySize } from '@/main/platform/disk'
import { makeTempDir } from '../../../fixtures/fs'

describe('directorySize', () => {
  it('sums every file below a directory, counting entries', async () => {
    const dir = await makeTempDir()
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'one.txt'), 'x'.repeat(10))
    await writeFile(join(dir, 'a', 'two.txt'), 'x'.repeat(20))
    await writeFile(join(dir, 'a', 'b', 'three.txt'), 'x'.repeat(30))
    const result = await directorySize(dir)
    expect(result).toMatchObject({ ok: true, entries: 5, truncated: false })
    expect(result.ok && result.bytes >= 60).toBe(true)
  })

  it('never follows a symlink out of the tree', async () => {
    const outside = await makeTempDir()
    await writeFile(join(outside, 'big.bin'), 'x'.repeat(100_000))
    const dir = await makeTempDir()
    await symlink(outside, join(dir, 'link'))
    const result = await directorySize(dir)
    expect(result.ok && result.bytes < 100_000).toBe(true)
  })

  it('stops at maxEntries and reports truncated, never an exact-looking undercount', async () => {
    const dir = await makeTempDir()
    for (let i = 0; i < 6; i += 1) await writeFile(join(dir, `f${String(i)}`), 'x')
    const result = await directorySize(dir, { maxEntries: 3 })
    expect(result).toMatchObject({ ok: true, entries: 3, truncated: true })
  })

  it('reports not-found for a missing path', async () => {
    const dir = await makeTempDir()
    await expect(directorySize(join(dir, 'missing'))).resolves.toMatchObject({ ok: false, kind: 'not-found' })
  })

  it('measures a single file', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'f'), 'x'.repeat(42))
    await expect(directorySize(join(dir, 'f'))).resolves.toEqual({ ok: true, bytes: 42, entries: 0, truncated: false })
  })
})

// Lives here, not in `renderer/local/inspect.test.ts`, which must import nothing from `src/main/`.
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandResult } from '@/types/platform'
import { inspectDenials } from '@/renderer/local/inspect'
import { pathOps } from '@/main/platform/paths'
import { readDenials } from '@/main/repos/local/denials'
import { createFakeClock, createFakeFs, fakeGit } from '../../../../support/fake-platform'

// Reproduces the scope mismatch between a capped `entries` and the whole-file `summary`.
describe('inspectDenials — capped real-shaped fixture', () => {
  const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }

  it('reconciles byActor misses against window, not the whole-file summary', async () => {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'denials-capped.log')
    const logText = await readFile(fixturePath, 'utf8')

    const clock = createFakeClock('2026-01-01T00:00:00.000Z')
    const fs = createFakeFs(clock)
    const root = pathOps.toNative('/repo')
    await fs.writeText(pathOps.join(root, '.agents', 'denials.log'), logText)

    const read = await readDenials({ git: fakeGit(() => Promise.resolve(NOT_A_REPO)), fs, clock }, root, { limit: 5 })
    if (!read.ok || !read.present) throw new Error('expected present')
    expect(read.capped).toBe(true)

    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')

    const missAcrossActors = result.byActor.reduce((sum, group) => sum + group.counts.miss, 0)
    expect(missAcrossActors).toBe(result.window.misses)
    expect(result.summary.misses).toBeGreaterThan(result.window.misses)
  })
})

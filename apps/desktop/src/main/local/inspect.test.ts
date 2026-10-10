// Lives here, not in `shared/local/inspect.test.ts`, which must import nothing from `src/main/`.
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandResult } from '../platform/run'
import { inspectDenials } from '../../shared/local/inspect'
import { readDenials } from './denials'
import type { GitRunner } from './denials'

const realRead = await readDenials({ repoRoot: process.cwd() })
const hasRealLog = realRead.ok && realRead.present

describe.skipIf(!hasRealLog)('inspectDenials — this repository real log', () => {
  it('holds its structural invariants against the real .agents/denials.log', () => {
    const result = inspectDenials({ read: realRead, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')

    expect(result.analysed).toBeLessThanOrEqual(result.summary.total)
    expect(result.capped).toBe(result.analysed < result.summary.total)

    const tally = result.attribution
    expect(tally.agentAttributed + tally.sessionAttributed + tally.sessionUnresolved + tally.attributionUnavailable + tally.unattributable).toBe(result.analysed)

    expect(result.window.misses).toBeGreaterThan(0)
    // Every group's own `miss` bucket sums back to the analysed window's total, never the whole-file `summary`.
    const missAcrossActors = result.byActor.reduce((sum, group) => sum + group.counts.miss, 0)
    expect(missAcrossActors).toBe(result.window.misses)
  })
})

// Reproduces the scope mismatch between a capped `entries` and the whole-file `summary`.
describe('inspectDenials — capped real-shaped fixture', () => {
  const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }

  it('reconciles byActor misses against window, not the whole-file summary', async () => {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'denials-capped.log')
    const logText = await readFile(fixturePath, 'utf8')

    const root = await mkdtemp(join(tmpdir(), 'port-local-inspect-capped-'))
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'denials.log'), logText, 'utf8')
    const git: GitRunner = () => Promise.resolve(NOT_A_REPO) // degrades to repoRoot itself

    const read = await readDenials({ repoRoot: root, git, limit: 5, now: () => new Date('2026-01-01T00:00:00.000Z') })
    if (!read.ok || !read.present) throw new Error('expected present')
    expect(read.capped).toBe(true)

    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')

    const missAcrossActors = result.byActor.reduce((sum, group) => sum + group.counts.miss, 0)
    expect(missAcrossActors).toBe(result.window.misses)
    expect(result.summary.misses).toBeGreaterThan(result.window.misses)
  })
})

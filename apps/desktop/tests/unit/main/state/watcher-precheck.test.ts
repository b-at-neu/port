import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardSnapshot } from '@/types/board'
import type { GitHubTransport } from '@/types/platform'
import { createPipelineWatcher } from '@/main/state/watcher'
import { RATE_LIMIT_REPLY } from '../../../fixtures/pipeline-reply'
import { fakeGit, makeFakeTimer, readyEntry, readyItemTransport, scriptedConditional } from '../../../fixtures/watcher-harness'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

interface Rig {
  readonly step: (ms: number) => Promise<BoardSnapshot>
  readonly conditional: ReturnType<typeof scriptedConditional>
  readonly sweeps: () => number
  readonly setLabels: (labels: readonly string[]) => void
  readonly elapsed: () => number
}

async function rig(rateLimit: unknown = RATE_LIMIT_REPLY): Promise<Rig> {
  let currentMs = T0
  let labels: readonly string[] = ['ready']
  let sweeps = 0
  let resolveNext: ((snapshot: BoardSnapshot) => void) | null = null
  const timer = makeFakeTimer()
  const conditional = scriptedConditional()
  const root = await mkdtemp(join(tmpdir(), 'port-precheck-'))
  const github: GitHubTransport = (request) => {
    sweeps += 1
    return readyItemTransport('op', ['op'], rateLimit, labels)(request)
  }
  const watcher = createPipelineWatcher({
    repositories: [readyEntry('repo-a', root, 'o/a')],
    onSnapshot: (snapshot) => resolveNext?.(snapshot),
    now: () => new Date(currentMs),
    setTimer: timer.factory,
    git: fakeGit({ worktreeList: 0 }),
    github,
    conditional: conditional.transport,
    sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
  })
  await watcher.refresh()
  sweeps = 0
  return {
    step: (ms) => {
      const next = new Promise<BoardSnapshot>((resolve) => {
        resolveNext = resolve
      })
      currentMs += ms
      timer.fire()
      return next
    },
    conditional,
    sweeps: () => sweeps,
    setLabels: (next) => {
      labels = next
    },
    elapsed: () => currentMs - T0,
  }
}

describe('createPipelineWatcher — issues-list pre-check', () => {
  it('a label change reaches the board within about one fast interval, well before the 60s sweep', async () => {
    const r = await rig()

    await r.step(10_000)
    expect(r.sweeps()).toBe(0)
    await r.step(10_000)
    expect(r.sweeps()).toBe(0)

    r.setLabels(['plan approved'])
    r.conditional.bump()
    const snap = await r.step(10_000)

    expect(r.elapsed()).toBe(30_000)
    expect(r.sweeps()).toBeGreaterThan(0)
    expect(snap.tick[0]?.actionable[0]?.trigger).toBe('planApproved')
  })

  it('holds a triggered sweep until the budgeted gap has passed, then runs it once', async () => {
    // Two round trips per sweep, so a sweep costs 20 points and the gap is about 29s.
    const r = await rig({ ...RATE_LIMIT_REPLY, cost: 10, resetAt: '2026-01-01T01:00:00Z' })

    await r.step(10_000)
    r.conditional.bump()
    await r.step(10_000)
    expect(r.sweeps()).toBe(0)

    await r.step(10_000)
    expect(r.sweeps()).toBeGreaterThan(0)
    const afterTriggered = r.sweeps()

    await r.step(10_000)
    expect(r.sweeps()).toBe(afterTriggered)
  })

  it('makes no pre-check call while GitHub is deferred', async () => {
    const r = await rig({ ...RATE_LIMIT_REPLY, remaining: 10, resetAt: '2026-01-01T01:00:00Z' })

    await r.step(10_000)
    await r.step(10_000)

    expect(r.conditional.calls()).toBe(0)
    expect(r.sweeps()).toBe(0)
  })

  it('a failing pre-check leaves GitHub health alone and the regular sweep still runs', async () => {
    const r = await rig()
    r.conditional.fail(true)

    const snap = await r.step(10_000)
    expect(r.conditional.calls()).toBe(1)
    expect(snap.health[0]?.github.consecutiveFailures).toBe(0)
    expect(snap.health[0]?.github.lastError).toBeNull()

    await r.step(50_000)
    expect(r.sweeps()).toBeGreaterThan(0)
  })

  it('schedules the next wakeup at the pre-check instant through the one timer', async () => {
    const r = await rig()

    await r.step(10_000)
    const snap = await r.step(5_000)

    expect(snap.nextWakeupAt).toBe(new Date(T0 + 20_000).toISOString())
  })
})

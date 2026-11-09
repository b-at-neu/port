import { describe, expect, it } from 'vitest'
import { BACKOFF_CEILING_MS, GITHUB_PRECHECK_INTERVAL_MS, initialHealth } from '@/types/board'
import type { SourceHealth } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { afterSuccess } from '@/main/state/schedule'
import { createGithubPrecheck, pendingSweepAt, precheckDueAt } from '@/main/state/precheck'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const repoId = 'repo-1' as RepoId
const target = { repoId, repo: { owner: 'o', name: 'a' } }
const GAP = 10_000

function swept(at: number): SourceHealth {
  return afterSuccess(initialHealth('github'), 'github', new Date(at))
}

type Mode = 'changed' | 'unchanged' | 'failed'

function setup(initial: Mode) {
  let currentMs = T0
  let calls = 0
  let mode = initial
  const tracker = createGithubPrecheck({
    now: () => new Date(currentMs),
    engine: {
      precheckGithub: () => {
        calls += 1
        const at = new Date(currentMs).toISOString()
        return Promise.resolve(mode === 'failed' ? { ok: false, at, error: 'boom' } : { ok: true, at, changed: mode === 'changed' })
      },
    },
  })
  return {
    tracker,
    advance: (ms: number) => void (currentMs += ms),
    advanceTo: (ms: number) => void (currentMs = ms),
    setMode: (next: Mode) => void (mode = next),
    calls: () => calls,
  }
}

describe('precheckDueAt', () => {
  const fresh = { health: { ...initialHealth('github'), intervalMs: GITHUB_PRECHECK_INTERVAL_MS }, pendingSince: null, inFlight: false }
  const now = new Date(T0 + 1_000)

  it('is not due before the first GitHub success', () => {
    expect(precheckDueAt(fresh, initialHealth('github'), now)).toBeNull()
  })

  it('is not due while GitHub is deferred', () => {
    const deferred = { ...swept(T0), deferredUntil: new Date(T0 + 3_600_000).toISOString() }
    expect(precheckDueAt(fresh, deferred, now)).toBeNull()
  })

  it('is not due while a sweep is pending or the sweep is already due', () => {
    expect(precheckDueAt({ ...fresh, pendingSince: new Date(T0).toISOString() }, swept(T0), now)).toBeNull()
    expect(precheckDueAt(fresh, swept(T0 - 60_000), now)).toBeNull()
  })

  it('is not due while one is in flight', () => {
    expect(precheckDueAt({ ...fresh, inFlight: true }, swept(T0), now)).toBeNull()
  })

  it('is due at its own interval after the last attempt', () => {
    const attempted = { ...fresh, health: { ...fresh.health, lastAttemptAt: new Date(T0).toISOString() } }
    expect(precheckDueAt(attempted, swept(T0), now)?.getTime()).toBe(T0 + GITHUB_PRECHECK_INTERVAL_MS)
  })
})

describe('pendingSweepAt', () => {
  const pending = { health: initialHealth('github'), pendingSince: new Date(T0).toISOString(), inFlight: false }

  it('is null with nothing pending', () => {
    expect(pendingSweepAt({ ...pending, pendingSince: null }, swept(T0), GAP)).toBeNull()
  })

  it('waits one gap after the last sweep attempt', () => {
    expect(pendingSweepAt(pending, swept(T0), GAP)?.getTime()).toBe(T0 + GAP)
  })

  it('never lands inside a deferral', () => {
    const deferred = { ...swept(T0), deferredUntil: new Date(T0 + 600_000).toISOString() }
    expect(pendingSweepAt(pending, deferred, GAP)?.getTime()).toBe(T0 + 600_000)
  })
})

describe('createGithubPrecheck', () => {
  it('a change sets pending, and the sweep is wanted only once the gap has passed', async () => {
    const { tracker, advance } = setup('changed')
    advance(10_000)
    await tracker.run(target, swept(T0))
    expect(tracker.wantsSweep(repoId, swept(T0 + 5_000), GAP)).toBe(false)
    expect(tracker.wantsSweep(repoId, swept(T0), GAP)).toBe(true)
  })

  it('an unchanged answer sets nothing pending', async () => {
    const { tracker, advance } = setup('unchanged')
    advance(10_000)
    await tracker.run(target, swept(T0))
    expect(tracker.wantsSweep(repoId, swept(T0), GAP)).toBe(false)
  })

  it('does nothing before its interval has passed', async () => {
    const { tracker, advance, calls } = setup('unchanged')
    advance(10_000)
    await tracker.run(target, swept(T0))
    await tracker.run(target, swept(T0))
    expect(calls()).toBe(1)
  })

  it('settled keeps a change that a sweep started before it could not have seen', async () => {
    const { tracker, advance } = setup('changed')
    advance(10_000)
    await tracker.run(target, swept(T0))
    tracker.settled(repoId, new Date(T0 + 5_000).toISOString(), true)
    expect(tracker.wantsSweep(repoId, swept(T0), GAP)).toBe(true)
  })

  it('settled clears pending for a sweep that started at or after the change', async () => {
    const { tracker, advance } = setup('changed')
    advance(10_000)
    await tracker.run(target, swept(T0))
    tracker.settled(repoId, new Date(T0 + 10_000).toISOString(), true)
    expect(tracker.wantsSweep(repoId, swept(T0), GAP)).toBe(false)
  })

  it('settled with a failed sweep keeps pending', async () => {
    const { tracker, advance } = setup('changed')
    advance(10_000)
    await tracker.run(target, swept(T0))
    tracker.settled(repoId, new Date(T0 + 20_000).toISOString(), false)
    expect(tracker.wantsSweep(repoId, swept(T0), GAP)).toBe(true)
  })

  it('two overlapping runs issue one engine call', async () => {
    const { tracker, advance, calls } = setup('unchanged')
    advance(10_000)
    await Promise.all([tracker.run(target, swept(T0)), tracker.run(target, swept(T0))])
    expect(calls()).toBe(1)
  })

  it('failures double the interval up to the ceiling, and a success resets it', async () => {
    const { tracker, advanceTo, setMode } = setup('failed')
    // GitHub's own next sweep is far off, so only the pre-check's pacing is under test.
    const github = { ...swept(T0), intervalMs: BACKOFF_CEILING_MS * 100 }
    let at = T0 + GITHUB_PRECHECK_INTERVAL_MS
    const intervals: number[] = []

    for (let i = 0; i < 9; i++) {
      advanceTo(at)
      await tracker.run(target, github)
      const due = tracker.nextDueAt(repoId, github, GAP)!.getTime()
      intervals.push(due - at)
      at = due
    }
    expect(intervals.slice(0, 3)).toEqual([20_000, 40_000, 80_000])
    expect(intervals.at(-1)).toBe(BACKOFF_CEILING_MS)

    setMode('unchanged')
    advanceTo(at)
    await tracker.run(target, github)
    expect(tracker.nextDueAt(repoId, github, GAP)!.getTime()).toBe(at + GITHUB_PRECHECK_INTERVAL_MS)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createInterruptedSweeper } from '@/main/stage/sweep'
import { createStageRegistry } from '@/main/stage/registry'
import type { BoardSnapshot } from '@/types/board'
import type { DispatchRecord, RepoDispatchStatus } from '@/types/dispatch'
import type { ItemsByNumberFetch } from '@/types/github'
import type { FileResult } from '@/types/platform'
import type { InterruptedStage, StageResumeResult } from '@/types/stage'
import type { RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, reconciledItem, repositoryState } from '../../../fixtures/board-state'

const REPO = 'repo-a' as RepoId
const INTERRUPTED_AT = new Date('2026-01-01T00:10:00.000Z')
const POLL_AT = '2026-01-01T00:20:00.000Z'
const RESET = '2026-01-01T05:00:00.000Z'
const AFTER_RESET = new Date('2026-01-01T05:30:00.000Z')

function freshRegistry(now: () => Date = () => INTERRUPTED_AT) {
  const readJson = <T>(): Promise<FileResult<T>> => Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
  const writeJsonAtomic = (): Promise<FileResult<void>> => Promise.resolve({ ok: true, value: undefined })
  return createStageRegistry({ path: '/tmp/stage-sessions.json', readJson, writeJsonAtomic, now })
}

type NewEntry = Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd' | 'interruptedAt'>

function newEntry(overrides: Partial<NewEntry> = {}): NewEntry {
  return {
    id: 'e1',
    repoId: REPO,
    agent: 'impl',
    number: 38,
    kind: 'issue',
    trigger: 'planApproved',
    inFlight: 'inProgress',
    model: 'sonnet',
    claudeSessionId: 'c1',
    worktree: { path: '/wt/e1', branch: 'b', baseSha: 's' },
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function interrupt(registry: ReturnType<typeof freshRegistry>, overrides: Partial<NewEntry> = {}, reason: InterruptedStage['reason'] = 'crash', resetsAt: string | null = null): void {
  const entry = newEntry(overrides)
  registry.recordRunning(entry)
  registry.markInterrupted(entry.id, reason, null, resetsAt, 1.5)
}

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

function snapshotWith(...items: Parameters<typeof repositoryState>[0]): BoardSnapshot {
  return boardSnapshot([repositoryState(items, { freshness: { github: { at: POLL_AT }, itemStates: { at: POLL_AT }, sessions: { at: POLL_AT }, worktrees: { at: POLL_AT }, denials: { at: POLL_AT } } })], POLL_AT)
}

const inFlight = reconciledItem({ number: 38, matchedKeys: ['inProgress'] })
const moved = reconciledItem({ number: 38, matchedKeys: ['prOpened'] })

function setup(registry = freshRegistry(), now: Date = AFTER_RESET) {
  const removeWorktree = vi.fn((): Promise<RemoveSessionWorktreeOutcome> => Promise.resolve({ outcome: 'removed' }))
  const fetchItemsByNumber = vi.fn((): Promise<ItemsByNumberFetch> => Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: POLL_AT }))
  const resume = vi.fn((id: string): Promise<StageResumeResult> => {
    void id
    return Promise.resolve({ kind: 'ok', sessionKey: 'hosted-1' })
  })
  const onChange = vi.fn()
  const sweeper = createInterruptedSweeper({ registry, fetchItemsByNumber, removeWorktree, resume, onChange, now: () => now })
  return { registry, sweeper, removeWorktree, fetchItemsByNumber, resume, onChange }
}

describe('createInterruptedSweeper — stale entries', () => {
  it('removes an entry whose ticket moved on, its worktree first, and reports one change', async () => {
    const deps = setup()
    interrupt(deps.registry)
    await deps.sweeper.consider(snapshotWith(moved), [status()])
    expect(deps.removeWorktree).toHaveBeenCalledWith('/wt/e1', false)
    expect(deps.registry.list()).toEqual([])
    expect(deps.onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps an entry whose ticket still carries its in-flight label', async () => {
    const deps = setup()
    interrupt(deps.registry)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.list()).toHaveLength(1)
    expect(deps.removeWorktree).not.toHaveBeenCalled()
    expect(deps.onChange).not.toHaveBeenCalled()
  })

  it('removes the entry even when its worktree is dirty or cannot be removed', async () => {
    for (const outcome of [{ outcome: 'dirty' }, { outcome: 'failed', message: 'locked' }] as const) {
      const deps = setup()
      deps.removeWorktree.mockResolvedValue(outcome)
      interrupt(deps.registry)
      await deps.sweeper.consider(snapshotWith(moved), [status()])
      expect(deps.removeWorktree).toHaveBeenCalledWith('/wt/e1', false)
      expect(deps.registry.list()).toEqual([])
    }
  })

  it('removes an entry superseded by a newer dispatch record', async () => {
    const deps = setup()
    interrupt(deps.registry)
    const launched: DispatchRecord = { agent: 'impl', number: 38, kind: 'issue', state: 'started', at: POLL_AT, detail: null, outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null }
    await deps.sweeper.consider(snapshotWith(inFlight), [status({ state: { kind: 'active', recent: [launched] } })])
    expect(deps.registry.list()).toEqual([])
  })

  it('rechecks tickets the sweep no longer returns with exactly one fetch for their numbers', async () => {
    const deps = setup()
    interrupt(deps.registry, { id: 'a', number: 38 })
    interrupt(deps.registry, { id: 'b', number: 39 })
    deps.fetchItemsByNumber.mockResolvedValue({ ok: true, resolved: [{ number: 38, kind: 'issue', state: 'CLOSED', mergedAt: null, closedAt: POLL_AT, title: 't', url: 'u', labels: [], assignees: [] }], unavailable: [39], fetchedAt: POLL_AT })
    await deps.sweeper.consider(snapshotWith(), [status()])
    expect(deps.fetchItemsByNumber).toHaveBeenCalledTimes(1)
    expect(deps.fetchItemsByNumber).toHaveBeenCalledWith({ repo: { owner: 'o', name: 'a' }, numbers: [38, 39] })
    expect(deps.registry.list().map((e) => e.id)).toEqual(['b'])
  })

  it('leaves an entry the operator resumed while the pass was reading GitHub', async () => {
    const deps = setup()
    interrupt(deps.registry)
    deps.fetchItemsByNumber.mockImplementation(() => {
      deps.registry.markRunning('e1')
      return Promise.resolve({ ok: true, resolved: [{ number: 38, kind: 'issue', state: 'CLOSED', mergedAt: null, closedAt: POLL_AT, title: 't', url: 'u', labels: [], assignees: [] }], unavailable: [], fetchedAt: POLL_AT })
    })
    await deps.sweeper.consider(snapshotWith(), [status()])
    expect(deps.removeWorktree).not.toHaveBeenCalled()
    expect(deps.onChange).not.toHaveBeenCalled()
    void deps.registry.markAllQuit()
    expect(deps.registry.list().map((e) => e.id)).toEqual(['e1'])
  })

  it('keeps an entry the operator resumed while its worktree was being removed', async () => {
    const deps = setup()
    interrupt(deps.registry)
    deps.removeWorktree.mockImplementation(() => {
      deps.registry.markRunning('e1')
      return Promise.resolve({ outcome: 'removed' })
    })
    await deps.sweeper.consider(snapshotWith(moved), [status()])
    expect(deps.onChange).not.toHaveBeenCalled()
    void deps.registry.markAllQuit()
    expect(deps.registry.list().map((e) => e.id)).toEqual(['e1'])
  })

  it('keeps every entry when the recheck itself fails', async () => {
    const deps = setup()
    interrupt(deps.registry)
    deps.fetchItemsByNumber.mockResolvedValue({ ok: false, kind: 'rate-limited', message: 'slow down', fetchedAt: POLL_AT })
    await deps.sweeper.consider(snapshotWith(), [status()])
    expect(deps.registry.list()).toHaveLength(1)
    expect(deps.onChange).not.toHaveBeenCalled()
  })

  it('never fetches when nothing is missing from the sweep', async () => {
    const deps = setup()
    interrupt(deps.registry)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.fetchItemsByNumber).not.toHaveBeenCalled()
  })

  it('clears nothing on a repository the board could not read', async () => {
    const deps = setup()
    interrupt(deps.registry)
    const blind = boardSnapshot([{ ok: false, repoId: REPO, displayName: 'o/a', reason: 'not-ready', problem: { kind: 'directory-missing' } }], POLL_AT)
    await deps.sweeper.consider(blind, [status()])
    expect(deps.registry.list()).toHaveLength(1)
    expect(deps.fetchItemsByNumber).not.toHaveBeenCalled()
  })
})

describe('createInterruptedSweeper — usage-limit auto-resume', () => {
  it('resumes entries past their reset on an app-owned running repository, oldest first', async () => {
    const clock = { now: new Date('2026-01-01T00:30:00.000Z') }
    const registry = freshRegistry(() => clock.now)
    interrupt(registry, { id: 'late', number: 40 }, 'usage-limit', RESET)
    clock.now = new Date('2026-01-01T00:10:00.000Z')
    interrupt(registry, { id: 'early', number: 39 }, 'usage-limit', RESET)
    const deps = setup(registry)
    const items = [reconciledItem({ number: 39, matchedKeys: ['inProgress'] }), reconciledItem({ number: 40, matchedKeys: ['inProgress'] })]
    await deps.sweeper.consider(snapshotWith(...items), [status()])
    expect(deps.resume.mock.calls.map(([id]) => id)).toEqual(['early', 'late'])
    expect(deps.onChange).toHaveBeenCalledTimes(1)
  })

  it('leaves entries alone before their reset, and in a paused or terminal-owned repository', async () => {
    const beforeReset = setup(freshRegistry(), new Date('2026-01-01T04:00:00.000Z'))
    interrupt(beforeReset.registry, {}, 'usage-limit', RESET)
    await beforeReset.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(beforeReset.resume).not.toHaveBeenCalled()

    for (const overrides of [{ runState: 'paused' as const }, { owner: 'terminal' as const }]) {
      const deps = setup()
      interrupt(deps.registry, {}, 'usage-limit', RESET)
      await deps.sweeper.consider(snapshotWith(inFlight), [status(overrides)])
      expect(deps.resume).not.toHaveBeenCalled()
      expect(deps.registry.list()).toHaveLength(1)
    }
  })

  it('stops for this pass when every slot is busy, and leaves the rest as they were', async () => {
    const registry = freshRegistry()
    interrupt(registry, { id: 'a', number: 38 }, 'usage-limit', RESET)
    interrupt(registry, { id: 'b', number: 39 }, 'usage-limit', RESET)
    const deps = setup(registry)
    deps.resume.mockResolvedValue({ kind: 'at-capacity', limit: 1 })
    await deps.sweeper.consider(snapshotWith(inFlight, reconciledItem({ number: 39, matchedKeys: ['inProgress'] })), [status()])
    expect(deps.resume).toHaveBeenCalledTimes(1)
    expect(registry.list().map((e) => e.reason)).toEqual(['usage-limit', 'usage-limit'])
    expect(deps.onChange).not.toHaveBeenCalled()
  })

  it('turns a failed resume into an ordinary error entry that is never retried', async () => {
    const deps = setup()
    interrupt(deps.registry, {}, 'usage-limit', RESET)
    deps.resume.mockResolvedValue({ kind: 'start-failed', message: 'runtime problem' })
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.list()[0]).toMatchObject({ reason: 'error', detail: "Couldn't resume after the usage limit reset: runtime problem", resetsAt: null, costUsd: 1.5 })
    expect(deps.onChange).toHaveBeenCalledTimes(1)

    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.resume).toHaveBeenCalledTimes(1)
  })

  it('explains a missing session id in the error entry', async () => {
    const deps = setup()
    interrupt(deps.registry, {}, 'usage-limit', RESET)
    deps.resume.mockResolvedValue({ kind: 'no-session-id' })
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.list()[0]?.detail).toBe("Couldn't resume after the usage limit reset: the session ended before Claude started it")
  })
})

describe('createInterruptedSweeper — passes', () => {
  it('serializes passes, so a slow one finishes before the next starts', async () => {
    const deps = setup()
    interrupt(deps.registry)
    const order: string[] = []
    let release: () => void = () => undefined
    deps.fetchItemsByNumber.mockImplementationOnce(
      () =>
        new Promise<ItemsByNumberFetch>((resolve) => {
          order.push('first-fetch')
          release = () => resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: POLL_AT })
        }),
    )
    deps.fetchItemsByNumber.mockImplementationOnce(() => {
      order.push('second-fetch')
      return Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: POLL_AT })
    })
    const first = deps.sweeper.consider(snapshotWith(), [status()])
    const second = deps.sweeper.consider(snapshotWith(), [status()])
    await vi.waitFor(() => expect(order).toEqual(['first-fetch']))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-fetch', 'second-fetch'])
  })

  it('survives a failing pass and runs the next one', async () => {
    const deps = setup()
    interrupt(deps.registry)
    deps.fetchItemsByNumber.mockRejectedValueOnce(new Error('network down'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await deps.sweeper.consider(snapshotWith(), [status()])
    expect(deps.registry.list()).toHaveLength(1)
    await deps.sweeper.consider(snapshotWith(moved), [status()])
    expect(deps.registry.list()).toEqual([])
    errors.mockRestore()
  })
})

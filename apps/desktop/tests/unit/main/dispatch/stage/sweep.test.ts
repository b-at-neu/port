import { describe, expect, it, vi } from 'vitest'
import { createInterruptedSweeper } from '@/main/dispatch/stage/sweep'
import type { AppContext } from '@/main/app/context'
import type { BoardSnapshot } from '@/types/board'
import type { DispatchRecord, RepoDispatchStatus } from '@/types/dispatch'
import type { ItemsByNumberFetch } from '@/types/github'
import type { InterruptedStage, RunStore, StageRestartResult, StageResumeResult } from '@/types/stage'
import type { RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, reconciledItem, repositoryState } from '../../../../support/board-snapshot'
import { createTestContext } from '../../../../support/context'
import { createFakeRuns, type NewRun } from '../../../../support/fake-runs'
import { createFakeTracker } from '../../../../support/fake-tracker'
import { queuedAt, ticketAt } from '../../../../support/tickets'

const REPO = 'repo-a' as RepoId
const INTERRUPTED_AT = new Date('2026-01-01T00:10:00.000Z')
const POLL_AT = '2026-01-01T00:20:00.000Z'
const RESET = '2026-01-01T05:00:00.000Z'
const AFTER_RESET = new Date('2026-01-01T05:30:00.000Z')

function freshRegistry(now: () => Date = () => INTERRUPTED_AT) {
  return createFakeRuns(now)
}

type NewEntry = NewRun

function newEntry(overrides: Partial<NewEntry> = {}): NewEntry {
  return {
    id: 'e1',
    repoId: REPO,
    agent: 'impl',
    number: 38,
    kind: 'issue',
    trigger: 'planApproved',
    stage: 'implement',
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
  void registry.interrupt(entry.repoId, entry.id, { reason, detail: null, resetsAt, costUsd: 1.5, outcome: null })
}

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

function snapshotWith(...items: Parameters<typeof repositoryState>[0]): BoardSnapshot {
  return boardSnapshot([repositoryState(items, { freshness: { github: { at: POLL_AT }, itemStates: { at: POLL_AT }, sessions: { at: POLL_AT }, worktrees: { at: POLL_AT }, denials: { at: POLL_AT } } })], POLL_AT)
}

const running = (number: number) => reconciledItem({ number, ticket: ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: number }) })
const inFlight = running(38)
const moved = reconciledItem({ number: 38, ticket: ticketAt('review', queuedAt(), { ticket: 38 }) })

const hoisted = vi.hoisted(() => ({ remove: vi.fn(), fetch: vi.fn(), resume: vi.fn(), restart: vi.fn() }))
vi.mock('@/main/repos/worktree/worktree', async (original) => ({ ...(await original<object>()), removeSessionWorktreeAt: (_ctx: unknown, params: { path: string; force: boolean }) => hoisted.remove(params.path, params.force) as unknown }))
vi.mock('@/main/dispatch/stage/recover', async (original) => ({
  ...(await original<object>()),
  resumeStage: (_ctx: unknown, id: string) => hoisted.resume(id) as unknown,
  restartStage: (_ctx: unknown, id: string) => hoisted.restart(id) as unknown,
}))

const CLOCK_START = Date.parse('2026-01-01T00:00:00.000Z')

function setup(registry = freshRegistry(), now: Date = AFTER_RESET) {
  const removeWorktree = hoisted.remove.mockReset().mockImplementation((): Promise<RemoveSessionWorktreeOutcome> => Promise.resolve({ outcome: 'removed' }))
  const fetchItemsByNumber = hoisted.fetch.mockReset().mockImplementation((): Promise<ItemsByNumberFetch> => Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: POLL_AT }))
  const resume = hoisted.resume.mockReset().mockImplementation((id: string): Promise<StageResumeResult> => {
    void id
    return Promise.resolve({ kind: 'ok', sessionKey: 'hosted-1' })
  })
  const restart = hoisted.restart.mockReset().mockImplementation((id: string): Promise<StageRestartResult> => {
    void id
    return Promise.resolve({ kind: 'ok' })
  })
  const live: string[] = []
  const republish = vi.fn()
  const hostedStore = { list: () => live.map((path) => ({ phase: 'streaming', workspace: { worktree: { path } } })), capacity: () => Promise.resolve({ limit: 4 }) } as unknown as AppContext['live']['hostedStore']
  const watcher = { republish, snapshot: vi.fn() } as unknown as AppContext['live']['watcher']
  const tracker = createFakeTracker({ readItemsByNumber: (params) => hoisted.fetch(params) as Promise<ItemsByNumberFetch> })
  const ctx = createTestContext({ tracker, stores: { runs: registry as unknown as RunStore }, live: { hostedStore, watcher } })
  ctx.clock.advance(now.getTime() - CLOCK_START)
  const pathExists = vi.spyOn(ctx.fs, 'exists').mockResolvedValue(true)
  const sweeper = createInterruptedSweeper(ctx)
  return { registry, sweeper, removeWorktree, pathExists, fetchItemsByNumber, resume, restart, live, onChange: republish }
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

  it('keeps the entry as cleanup-failed when its worktree is dirty or cannot be removed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const [outcome, detail] of [
      [{ outcome: 'dirty' }, 'it has uncommitted changes'],
      [{ outcome: 'failed', message: ' locked \n' }, 'locked'],
    ] as const) {
      const deps = setup()
      deps.removeWorktree.mockResolvedValue(outcome)
      interrupt(deps.registry)
      await deps.sweeper.consider(snapshotWith(moved), [status()])
      expect(deps.removeWorktree).toHaveBeenCalledWith('/wt/e1', false)
      expect(deps.registry.list()[0]).toMatchObject({ reason: 'cleanup-failed', detail, resetsAt: null, costUsd: 1.5 })
      expect(deps.onChange).toHaveBeenCalledTimes(1)
    }
    errors.mockRestore()
  })

  it('leaves a cleanup-failed entry unchanged and silent while its worktree still cannot be removed', async () => {
    const clock = { now: INTERRUPTED_AT }
    const registry = freshRegistry(() => clock.now)
    interrupt(registry, {}, 'cleanup-failed')
    const deps = setup(registry)
    deps.removeWorktree.mockResolvedValue({ outcome: 'dirty' })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    clock.now = AFTER_RESET
    await deps.sweeper.consider(snapshotWith(moved), [status()])
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1)
    expect(registry.list()[0]).toMatchObject({ reason: 'cleanup-failed', interruptedAt: INTERRUPTED_AT.toISOString() })
    expect(deps.onChange).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('removes a cleanup-failed entry once its worktree can be removed', async () => {
    const registry = freshRegistry()
    interrupt(registry, {}, 'cleanup-failed')
    const deps = setup(registry)
    await deps.sweeper.consider(snapshotWith(moved), [status()])
    expect(registry.list()).toEqual([])
    expect(deps.onChange).toHaveBeenCalledTimes(1)
  })

  it('removes a cleanup-failed entry whose worktree folder is gone without asking git', async () => {
    const registry = freshRegistry()
    interrupt(registry, {}, 'cleanup-failed')
    const deps = setup(registry)
    deps.pathExists.mockResolvedValue(false)
    await deps.sweeper.consider(snapshotWith(moved), [status()])
    expect(deps.removeWorktree).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
  })

  it('removes an entry superseded by a newer dispatch record', async () => {
    const deps = setup()
    interrupt(deps.registry)
    const launched: DispatchRecord = { agent: 'impl', number: 38, kind: 'issue', trigger: 'planApproved', state: 'started', at: POLL_AT, detail: null, outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null }
    await deps.sweeper.consider(snapshotWith(inFlight), [status({ state: { kind: 'active', recent: [launched] } })])
    expect(deps.registry.list()).toEqual([])
  })

  it('rechecks tickets the sweep no longer returns with exactly one fetch for their numbers', async () => {
    const deps = setup()
    interrupt(deps.registry, { id: 'a', number: 38 })
    interrupt(deps.registry, { id: 'b', number: 39 })
    deps.fetchItemsByNumber.mockResolvedValue({ ok: true, resolved: [{ number: 38, kind: 'issue', state: 'CLOSED', mergedAt: null, closedAt: POLL_AT, title: 't', url: 'u', labels: [], assignees: [], headRefName: null, author: null }], unavailable: [39], fetchedAt: POLL_AT })
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
      return Promise.resolve({ ok: true, resolved: [{ number: 38, kind: 'issue', state: 'CLOSED', mergedAt: null, closedAt: POLL_AT, title: 't', url: 'u', labels: [], assignees: [], headRefName: null, author: null }], unavailable: [], fetchedAt: POLL_AT })
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
    const items = [running(39), running(40)]
    await deps.sweeper.consider(snapshotWith(...items), [status()])
    expect(deps.resume.mock.calls.map((call: readonly unknown[]) => call[0])).toEqual(['early', 'late'])
    expect(deps.onChange).toHaveBeenCalledTimes(1)
  })

  it('leaves entries alone before their reset, and in a paused or unreadable repository', async () => {
    const beforeReset = setup(freshRegistry(), new Date('2026-01-01T04:00:00.000Z'))
    interrupt(beforeReset.registry, {}, 'usage-limit', RESET)
    await beforeReset.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(beforeReset.resume).not.toHaveBeenCalled()

    for (const overrides of [{ runState: 'paused' as const }, { owner: 'unreadable' as const }]) {
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
    await deps.sweeper.consider(snapshotWith(inFlight, running(39)), [status()])
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

describe('createInterruptedSweeper — orphaned running entries', () => {
  it('marks a running entry no live session holds as a crash, so it can be cleared or resumed', async () => {
    const deps = setup()
    deps.registry.recordRunning(newEntry())
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.running()).toEqual([])
    expect(deps.registry.list()[0]).toMatchObject({ reason: 'crash', detail: 'the session ended without a hand-back' })
    expect(deps.onChange).toHaveBeenCalledTimes(1)
  })

  it('leaves a running entry alone while a live session holds its worktree', async () => {
    const deps = setup()
    deps.registry.recordRunning(newEntry())
    deps.live.push('/wt/e1')
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.running()).toHaveLength(1)
    expect(deps.onChange).not.toHaveBeenCalled()
  })
})

describe('createInterruptedSweeper — network failures', () => {
  const NETWORK_NOW = new Date('2026-01-01T00:11:00.000Z')

  function networkEntry(deps: ReturnType<typeof setup>, retries: number): void {
    deps.registry.recordRunning(newEntry())
    const network = (costUsd: number | null) => void deps.registry.interrupt(REPO, 'e1', { reason: 'network', detail: 'EAI_AGAIN', resetsAt: null, costUsd, outcome: null })
    for (let i = 0; i < retries; i++) {
      network(null)
      deps.registry.markRunning('e1')
    }
    network(1.5)
  }

  it('resumes a network entry once its backoff has passed', async () => {
    const deps = setup(freshRegistry(), NETWORK_NOW)
    networkEntry(deps, 0)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.resume).toHaveBeenCalledWith('e1')
  })

  it('waits while the backoff is still running', async () => {
    const deps = setup(freshRegistry(), new Date('2026-01-01T00:10:30.000Z'))
    networkEntry(deps, 0)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.resume).not.toHaveBeenCalled()
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it('restarts an entry that stayed down after three retries', async () => {
    const deps = setup(freshRegistry(), NETWORK_NOW)
    networkEntry(deps, 3)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.resume).not.toHaveBeenCalled()
    expect(deps.restart).toHaveBeenCalledWith('e1')
    expect(deps.onChange).toHaveBeenCalled()
  })

  it('turns a dirty restart into an error entry naming the uncommitted changes', async () => {
    const deps = setup(freshRegistry(), NETWORK_NOW)
    deps.restart.mockResolvedValue({ kind: 'worktree-dirty' })
    networkEntry(deps, 3)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.list()[0]).toMatchObject({ reason: 'error', networkRetries: 0, detail: 'the network stayed down after 3 retries, and its worktree has uncommitted changes' })
  })

  it('reports any other refusal as an error entry with its reason', async () => {
    const deps = setup(freshRegistry(), NETWORK_NOW)
    deps.restart.mockResolvedValue({ kind: 'label-refused', reason: 'moved' })
    networkEntry(deps, 3)
    await deps.sweeper.consider(snapshotWith(inFlight), [status()])
    expect(deps.registry.list()[0]).toMatchObject({ reason: 'error' })
    expect(deps.registry.list()[0]?.detail).toContain('moved')
  })
})

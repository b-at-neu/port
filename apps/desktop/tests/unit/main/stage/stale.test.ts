import { describe, expect, it } from 'vitest'
import { AUTO_RESUME_GRACE_MS, autoResumable, clearedByRecheck, staleInterrupted } from '@/main/stage/stale'
import type { DispatchRecord, RepoDispatchStatus } from '@/types/dispatch'
import type { ItemsByNumberFetch, ResolvedItem } from '@/types/github'
import type { InterruptedStage } from '@/types/stage'
import type { RepositoryState } from '@/types/state'
import type { RepoId } from '@/utils/repos'
import { reconciledItem, repositoryState } from '../../../fixtures/board-state'

const REPO = 'repo-a' as RepoId
const INTERRUPTED_AT = '2026-01-01T00:10:00.000Z'
const AFTER = '2026-01-01T00:20:00.000Z'
const BEFORE = '2026-01-01T00:05:00.000Z'

function entry(overrides: Partial<InterruptedStage> = {}): InterruptedStage {
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
    worktree: { path: '/wt', branch: 'b', baseSha: 's' },
    startedAt: '2026-01-01T00:00:00.000Z',
    interruptedAt: INTERRUPTED_AT,
    reason: 'crash',
    detail: null,
    resetsAt: null,
    costUsd: null,
    ...overrides,
  }
}

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return { agent: 'impl', number: 38, kind: 'issue', state: 'started', at: AFTER, detail: null, outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null, ...overrides }
}

const inFlightItem = reconciledItem({ number: 38, kind: 'issue', matchedKeys: ['inProgress'] })

const NOT_READY: RepositoryState = { ok: false, repoId: REPO, displayName: 'o/a', reason: 'not-ready', problem: { kind: 'directory-missing' } }

function repoWith(items: Parameters<typeof repositoryState>[0], overrides: Parameters<typeof repositoryState>[1] = {}, readAt = AFTER): RepositoryState {
  return repositoryState(items, { freshness: { github: { at: readAt }, itemStates: { at: readAt }, sessions: { at: readAt }, worktrees: { at: readAt }, denials: { at: readAt } }, ...overrides }, readAt)
}

describe('staleInterrupted — a newer session', () => {
  it('clears an entry once a later dispatch record exists for its ticket', () => {
    const verdict = staleInterrupted({ entries: [entry()], repo: repoWith([inFlightItem]), recent: [record({ at: AFTER })] })
    expect(verdict.clear).toEqual(['e1'])
  })

  it('keeps it when the only record is its own launch, at or before the interruption', () => {
    const recent = [record({ at: BEFORE }), record({ at: INTERRUPTED_AT })]
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([inFlightItem]), recent }).clear).toEqual([])
  })

  it('keeps it when the later record is a failed launch or another ticket', () => {
    const recent = [record({ state: 'failed', at: AFTER }), record({ number: 99, at: AFTER }), record({ kind: 'pull-request', at: AFTER })]
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([inFlightItem]), recent }).clear).toEqual([])
  })

  it('counts a still-running and an ended later session alike', () => {
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([inFlightItem]), recent: [record({ state: 'ended' })] }).clear).toEqual(['e1'])
  })

  it('clears on a newer session even when the GitHub read is blind', () => {
    expect(staleInterrupted({ entries: [entry()], repo: NOT_READY, recent: [record()] }).clear).toEqual(['e1'])
  })
})

describe('staleInterrupted — one survivor per ticket', () => {
  it('keeps only the entry interrupted last', () => {
    const older = entry({ id: 'old', interruptedAt: BEFORE })
    const newer = entry({ id: 'new', interruptedAt: INTERRUPTED_AT })
    expect(staleInterrupted({ entries: [older, newer], repo: repoWith([inFlightItem], {}, BEFORE), recent: [] }).clear).toEqual(['old'])
    expect(staleInterrupted({ entries: [newer, older], repo: repoWith([inFlightItem], {}, BEFORE), recent: [] }).clear).toEqual(['old'])
  })

  it('on a tie keeps the later entry in list order', () => {
    const a = entry({ id: 'a' })
    const b = entry({ id: 'b' })
    expect(staleInterrupted({ entries: [a, b], repo: repoWith([inFlightItem]), recent: [] }).clear).toEqual(['a'])
  })

  it('leaves entries of different tickets alone', () => {
    const verdict = staleInterrupted({ entries: [entry({ id: 'a' }), entry({ id: 'b', number: 39 })], repo: repoWith([inFlightItem, reconciledItem({ number: 39, matchedKeys: ['inProgress'] })]), recent: [] })
    expect(verdict.clear).toEqual([])
  })
})

describe('staleInterrupted — the label moved', () => {
  it('clears when the ticket no longer carries the entry’s in-flight label', () => {
    const moved = reconciledItem({ number: 38, matchedKeys: ['prOpened'] })
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([moved]), recent: [] })).toEqual({ clear: ['e1'], recheck: [] })
  })

  it('keeps it while the in-flight label is still there', () => {
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([inFlightItem]), recent: [] })).toEqual({ clear: [], recheck: [] })
  })

  it('rechecks a ticket the label sweep no longer returns', () => {
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([]), recent: [] })).toEqual({ clear: [], recheck: [38] })
  })

  it('asks for each missing number once', () => {
    const verdict = staleInterrupted({ entries: [entry({ id: 'a', interruptedAt: BEFORE }), entry({ id: 'b' })], repo: repoWith([]), recent: [] })
    expect(verdict.recheck).toEqual([38])
  })
})

describe('staleInterrupted — a read that cannot be trusted clears nothing', () => {
  const moved = reconciledItem({ number: 38, matchedKeys: ['prOpened'] })

  it('ignores a repository that is not ready', () => {
    expect(staleInterrupted({ entries: [entry()], repo: NOT_READY, recent: [] })).toEqual({ clear: [], recheck: [] })
  })

  it('ignores a read with an unavailable alias', () => {
    const repo = repoWith([moved], { unavailable: [{ alias: 'issues', surface: 'issue' }] })
    expect(staleInterrupted({ entries: [entry()], repo, recent: [] })).toEqual({ clear: [], recheck: [] })
  })

  it('ignores a truncated read, which would call a missing ticket gone', () => {
    const repo = repoWith([], { truncated: [{ alias: 'issues', surface: 'issue', totalCount: 200, received: 100 }] })
    expect(staleInterrupted({ entries: [entry()], repo, recent: [] })).toEqual({ clear: [], recheck: [] })
  })

  it('ignores a read that failed or predates the interruption', () => {
    const failed = repoWith([moved], { freshness: { github: { unavailable: 'rate limited' }, itemStates: { at: AFTER }, sessions: { at: AFTER }, worktrees: { at: AFTER }, denials: { at: AFTER } } })
    expect(staleInterrupted({ entries: [entry()], repo: failed, recent: [] })).toEqual({ clear: [], recheck: [] })
    expect(staleInterrupted({ entries: [entry()], repo: repoWith([moved], {}, BEFORE), recent: [] })).toEqual({ clear: [], recheck: [] })
  })
})

describe('clearedByRecheck', () => {
  const resolved = (overrides: Partial<ResolvedItem> = {}): ResolvedItem => ({ number: 38, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: [], headRefName: null, ...overrides })
  const fetched = (items: readonly ResolvedItem[], unavailable: readonly number[] = []): ItemsByNumberFetch => ({ ok: true, resolved: items, unavailable, fetchedAt: AFTER })

  it('clears a merged, a closed and an open-but-unlabelled ticket', () => {
    expect(clearedByRecheck([entry()], fetched([resolved({ state: 'MERGED', mergedAt: AFTER, kind: 'pull-request' })]))).toEqual(['e1'])
    expect(clearedByRecheck([entry()], fetched([resolved({ state: 'CLOSED', closedAt: AFTER })]))).toEqual(['e1'])
    expect(clearedByRecheck([entry()], fetched([resolved({ state: 'OPEN' })]))).toEqual(['e1'])
  })

  it('keeps an entry whose number is unavailable or absent', () => {
    expect(clearedByRecheck([entry()], fetched([], [38]))).toEqual([])
    expect(clearedByRecheck([entry()], fetched([resolved({ number: 99 })]))).toEqual([])
  })

  it('keeps every entry when the fetch failed', () => {
    expect(clearedByRecheck([entry()], { ok: false, kind: 'rate-limited', message: 'slow down', fetchedAt: AFTER })).toEqual([])
  })

  it('clears only the entries whose own number resolved', () => {
    const entries = [entry({ id: 'a', number: 38 }), entry({ id: 'b', number: 39 })]
    expect(clearedByRecheck(entries, fetched([resolved({ number: 39 })]))).toEqual(['b'])
  })
})

describe('autoResumable', () => {
  const RESET = '2026-01-01T05:00:00.000Z'
  const AFTER_RESET = new Date(Date.parse(RESET) + AUTO_RESUME_GRACE_MS)
  const limited = (overrides: Partial<InterruptedStage> = {}) => entry({ reason: 'usage-limit', resetsAt: RESET, ...overrides })
  const running = (overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus => ({
    repoId: REPO,
    owner: 'app',
    state: { kind: 'idle' },
    runState: 'dispatching',
    ownedSince: null,
    unreadableMessage: null,
    budget: null,
    observed: [],
    denials: [],
    interrupted: [],
    ...overrides,
  })

  it('returns a usage-limit entry once the reset plus the grace has passed', () => {
    expect(autoResumable([limited()], AFTER_RESET, [running()])).toEqual(['e1'])
  })

  it('waits out the grace window after the reset', () => {
    expect(autoResumable([limited()], new Date(Date.parse(RESET) + AUTO_RESUME_GRACE_MS - 1), [running()])).toEqual([])
  })

  it('never resumes an entry with no known reset, no session id, or another reason', () => {
    expect(autoResumable([limited({ resetsAt: null })], AFTER_RESET, [running()])).toEqual([])
    expect(autoResumable([limited({ claudeSessionId: null })], AFTER_RESET, [running()])).toEqual([])
    expect(autoResumable([entry({ reason: 'crash', resetsAt: RESET })], AFTER_RESET, [running()])).toEqual([])
  })

  it.each([
    ['paused', { runState: 'paused' as const }],
    ['draining', { runState: 'draining' as const }],
    ['terminal-owned', { owner: 'terminal' as const }],
    ['unowned', { owner: 'none' as const }],
    ['unreadable', { owner: 'unreadable' as const }],
  ])('never launches into a %s repository', (_name, overrides) => {
    expect(autoResumable([limited()], AFTER_RESET, [running(overrides)])).toEqual([])
  })

  it('never launches into a repository with no dispatch status', () => {
    expect(autoResumable([limited()], AFTER_RESET, [])).toEqual([])
  })

  it('orders the oldest interruption first', () => {
    const entries = [limited({ id: 'late', interruptedAt: INTERRUPTED_AT }), limited({ id: 'early', interruptedAt: BEFORE })]
    expect(autoResumable(entries, AFTER_RESET, [running()])).toEqual(['early', 'late'])
  })
})

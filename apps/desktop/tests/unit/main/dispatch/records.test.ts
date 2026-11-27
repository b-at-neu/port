import { describe, expect, it } from 'vitest'
import { REDISPATCH_FLOOR_MS, SETTLE_GRACE_MS, boundRecords, endedStagesOf, selectDispatches, settlingDescriptions, syncChanges } from '@/main/dispatch/records'
import type { StageRecord } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { TickActionable } from '@/types/tick'
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import type { RepoId } from '@/utils/repos'

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    repoId: 'repo-a' as RepoId,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending' },
    title: null,
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
    usage: null,
    backgroundTasks: [],
    stage: null,
    lastResult: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

function actionable(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

function record(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    runId: 'run-1',
    sessionKey: 'hosted-1' as SessionKey,
    agent: 'impl',
    stage: 'implement',
    number: 52,
    kind: 'issue',
    state: 'started',
    at: '2026-01-01T00:00:00Z',
    endedAt: null,
    detail: null,
    outcome: null,
    claudeSessionId: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

const NOW = '2026-01-01T00:10:00.000Z'

describe('selectDispatches', () => {
  const T0 = '2026-09-05T14:00:00.000Z'

  it('passes through a candidate with no recent record at all', () => {
    expect(selectDispatches({ dispatchable: [actionable()], recent: [], now: new Date(T0) })).toHaveLength(1)
  })

  it('drops a candidate launched within the redispatch floor', () => {
    const now = new Date(Date.parse(T0) + REDISPATCH_FLOOR_MS - 1)
    expect(selectDispatches({ dispatchable: [actionable()], recent: [record({ at: T0 })], now })).toHaveLength(0)
  })

  it('passes a candidate through once the redispatch floor has elapsed', () => {
    const now = new Date(Date.parse(T0) + REDISPATCH_FLOOR_MS)
    expect(selectDispatches({ dispatchable: [actionable()], recent: [record({ at: T0 })], now })).toHaveLength(1)
  })

  it('applies the floor to a failed record too, not only a started one', () => {
    const now = new Date(Date.parse(T0) + 1000)
    expect(selectDispatches({ dispatchable: [actionable()], recent: [record({ state: 'failed', detail: 'boom', at: T0 })], now })).toHaveLength(0)
  })

  it('never matches a record for a different agent or number', () => {
    const recent = [record({ agent: 'review', at: T0 }), record({ number: 99, at: T0 })]
    expect(selectDispatches({ dispatchable: [actionable()], recent, now: new Date('2026-09-05T14:00:01.000Z') })).toHaveLength(1)
  })

  it('uses the newest of several matching records, not an arbitrary one', () => {
    const recent = [record({ at: '2026-09-05T13:00:00.000Z' }), record({ at: T0 })]
    expect(selectDispatches({ dispatchable: [actionable()], recent, now: new Date(Date.parse(T0) + 1000) })).toHaveLength(0)
  })
})

describe('endedStagesOf', () => {
  const COMPLETED = { kind: 'completed' as const, detail: null, costUsd: null, resetsAt: null, worktree: 'removed' as const, operatorJoined: false, handback: null }

  it('carries the hand-back write result for the record’s session', () => {
    const refused = { kind: 'refused' as const, reason: 'moved' as const, detail: null }
    const result = endedStagesOf([record({ state: 'ended', outcome: COMPLETED })], (key) => (key === 'hosted-1' ? refused : null))
    expect(result).toEqual([{ agent: 'impl', number: 52, outcome: 'completed', at: '2026-01-01T00:00:00Z', labels: refused }])
  })

  it('reports no labels result while the write is pending, and for a record with no session', () => {
    expect(endedStagesOf([record({ state: 'ended', outcome: COMPLETED })], () => null)[0]?.labels).toBeNull()
    expect(endedStagesOf([record({ state: 'failed', sessionKey: null, outcome: COMPLETED })], () => ({ kind: 'applied' }))[0]?.labels).toBeNull()
  })

  it('skips a live record and one with no outcome, and keeps the newest per number', () => {
    const older = record({ state: 'ended', outcome: COMPLETED, at: '2026-01-01T00:00:00Z' })
    const newer = record({ sessionKey: 'hosted-2' as SessionKey, state: 'ended', outcome: { ...COMPLETED, kind: 'error' }, at: '2026-01-01T01:00:00Z' })
    const live = record({ sessionKey: 'hosted-3' as SessionKey, number: 60, state: 'started', outcome: COMPLETED })
    const bare = record({ sessionKey: 'hosted-4' as SessionKey, number: 61, state: 'ended', outcome: null })
    expect(endedStagesOf([older, newer, live, bare], () => null)).toEqual([{ agent: 'impl', number: 52, outcome: 'error', at: '2026-01-01T01:00:00Z', labels: null }])
  })
})

describe('syncChanges', () => {
  const ended = { runId: 'run-1', change: { kind: 'ended', outcome: null } }

  it('ends a started record whose handle is gone or ended', () => {
    expect(syncChanges([record()], () => null)).toEqual([ended])
    expect(syncChanges([record()], () => snapshot({ phase: 'ended' }))).toEqual([ended])
  })

  it('leaves a started record alone while its handle is live', () => {
    expect(syncChanges([record()], () => snapshot({ phase: 'streaming' }))).toEqual([])
  })

  it('never touches an already-ended or failed record', () => {
    expect(syncChanges([record({ state: 'ended' }), record({ state: 'failed', sessionKey: null })], () => null)).toEqual([])
  })

  it('records an operator joining once, and still ends the run in the same pass', () => {
    const joined = { runId: 'run-1', change: { kind: 'joined', at: '2026-01-01T00:05:00.000Z' } }
    expect(syncChanges([record()], () => snapshot({ phase: 'streaming', operatorJoinedAt: '2026-01-01T00:05:00.000Z' }))).toEqual([joined])
    expect(syncChanges([record()], () => snapshot({ phase: 'ended', operatorJoinedAt: '2026-01-01T00:05:00.000Z' }))).toEqual([joined, ended])
    expect(syncChanges([record({ operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], () => snapshot({ phase: 'streaming', operatorJoinedAt: '2026-01-01T00:05:00.000Z' }))).toEqual([])
  })
})

describe('settlingDescriptions', () => {
  const now = new Date(NOW)
  const none: ReadonlySet<number> = new Set()

  it('counts an ended session with no classified outcome inside the grace as settling', () => {
    const ended = record({ state: 'ended', endedAt: '2026-01-01T00:09:00.000Z' })
    expect(settlingDescriptions([ended], none, now)).toEqual(['impl #52'])
  })

  it('stops counting it once the grace has passed, so a launcher that never reports is bounded', () => {
    const ended = record({ state: 'ended', endedAt: new Date(now.getTime() - SETTLE_GRACE_MS - 1).toISOString() })
    expect(settlingDescriptions([ended], none, now)).toEqual([])
  })

  it('never counts a session whose outcome was classified, a live one or a failed launch', () => {
    const classified = record({ state: 'ended', endedAt: '2026-01-01T00:09:30.000Z', outcome: { kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: null } })
    const live = record({ number: 53 })
    const failed = record({ number: 54, state: 'failed', sessionKey: null })
    expect(settlingDescriptions([classified, live, failed], none, now)).toEqual([])
  })

  it('counts a ticket whose hand-back write is still pending, however old its record is', () => {
    const classified = record({ state: 'ended', endedAt: '2026-01-01T00:01:00.000Z', outcome: { kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: null } })
    expect(settlingDescriptions([classified], new Set([52]), now)).toEqual(['impl #52'])
  })
})

describe('boundRecords', () => {
  it('passes through a list at or under the limit unchanged', () => {
    const records = [record(), record({ number: 53 })]
    expect(boundRecords(records, 2)).toBe(records)
  })

  it('drops the oldest non-live records first', () => {
    const records = [record({ number: 1, state: 'ended' }), record({ number: 2, state: 'ended' }), record({ number: 3, state: 'started' })]
    const result = boundRecords(records, 2)
    expect(result.map((r) => r.number)).toEqual([2, 3])
  })

  it('never drops a live record, even over the limit', () => {
    const records = [record({ number: 1, state: 'started' }), record({ number: 2, state: 'started' }), record({ number: 3, state: 'started' })]
    const result = boundRecords(records, 2)
    expect(result).toHaveLength(3)
  })
})

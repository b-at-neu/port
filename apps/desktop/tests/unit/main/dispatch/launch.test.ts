import { describe, expect, it } from 'vitest'
import { SETTLE_GRACE_MS, boundRecords, endedStagesOf, freeSlots, liveCount, refreshRecords, settlingDescriptions } from '@/main/dispatch/launch'
import type { StageRecord } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
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
    capabilities: { kind: 'pending', request: { source: 'installed' } },
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

function record(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    agent: 'impl',
    number: 52,
    kind: 'issue',
    trigger: 'planApproved',
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

describe('liveCount / freeSlots', () => {
  it('counts only non-ended snapshots', () => {
    expect(liveCount([snapshot({ phase: 'ready' }), snapshot({ phase: 'ended' }), snapshot({ phase: 'streaming' })])).toBe(2)
  })

  it('never returns a negative free count', () => {
    expect(freeSlots(1, [snapshot(), snapshot({ sessionKey: 'hosted-2' as SessionKey })])).toBe(0)
  })

  it('reports the remainder under the limit', () => {
    expect(freeSlots(4, [snapshot()])).toBe(3)
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

describe('refreshRecords', () => {
  it('ends a started record whose handle is gone, stamping when it was first seen ended', () => {
    const result = refreshRecords([record()], () => null, NOW)
    expect(result[0]?.state).toBe('ended')
    expect(result[0]?.endedAt).toBe(NOW)
  })

  it('ends a started record whose handle itself ended', () => {
    const result = refreshRecords([record()], () => snapshot({ phase: 'ended' }), NOW)
    expect(result[0]?.state).toBe('ended')
    expect(result[0]?.endedAt).toBe(NOW)
  })

  it('leaves a started record alone while its handle is still live', () => {
    const result = refreshRecords([record()], () => snapshot({ phase: 'streaming' }), NOW)
    expect(result[0]?.state).toBe('started')
    expect(result[0]?.endedAt).toBeNull()
  })

  it('never touches an already-ended or failed record', () => {
    const ended = record({ state: 'ended', endedAt: '2026-01-01T00:01:00.000Z' })
    const failed = record({ state: 'failed', sessionKey: null, detail: 'boom' })
    const result = refreshRecords([ended, failed], () => null, NOW)
    expect(result).toEqual([ended, failed])
  })

  it('copies claudeSessionId and operatorJoinedAt off a still-live snapshot', () => {
    const result = refreshRecords([record()], () => snapshot({ phase: 'streaming', claudeSessionId: 'sdk-1', operatorJoinedAt: '2026-01-01T00:05:00.000Z' }), NOW)
    expect(result[0]?.claudeSessionId).toBe('sdk-1')
    expect(result[0]?.operatorJoinedAt).toBe('2026-01-01T00:05:00.000Z')
  })

  it('keeps the newest copied values once the handle is gone', () => {
    const result = refreshRecords([record()], () => snapshot({ phase: 'ended', claudeSessionId: 'sdk-1', operatorJoinedAt: '2026-01-01T00:05:00.000Z' }), NOW)
    expect(result[0]?.state).toBe('ended')
    expect(result[0]?.claudeSessionId).toBe('sdk-1')
    expect(result[0]?.operatorJoinedAt).toBe('2026-01-01T00:05:00.000Z')
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

import { describe, expect, it } from 'vitest'
import { boundRecords, freeSlots, liveCount, refreshRecords } from './launch'
import type { StageRecord } from './launch'
import type { HostedSessionSnapshot, SessionKey } from '../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../shared/hosting/controls'
import type { RepoId } from '../../shared/repos'

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
    ...overrides,
  }
}

function record(overrides: Partial<StageRecord> = {}): StageRecord {
  return { sessionKey: 'hosted-1' as SessionKey, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', state: 'started', at: '2026-01-01T00:00:00Z', detail: null, ...overrides }
}

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

describe('refreshRecords', () => {
  it('ends a started record whose handle is gone', () => {
    const result = refreshRecords([record()], () => null)
    expect(result[0]?.state).toBe('ended')
  })

  it('ends a started record whose handle itself ended', () => {
    const result = refreshRecords([record()], () => snapshot({ phase: 'ended' }))
    expect(result[0]?.state).toBe('ended')
  })

  it('leaves a started record alone while its handle is still live', () => {
    const result = refreshRecords([record()], () => snapshot({ phase: 'streaming' }))
    expect(result[0]?.state).toBe('started')
  })

  it('never touches an already-ended or failed record', () => {
    const ended = record({ state: 'ended' })
    const failed = record({ state: 'failed', sessionKey: null, detail: 'boom' })
    const result = refreshRecords([ended, failed], () => null)
    expect(result).toEqual([ended, failed])
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

import { describe, expect, it } from 'vitest'
import { ticketSessionsFor } from '@/renderer/board/ticket-sessions'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { SessionIndexEntry } from '@/types/session-index'
import type { StageTag } from '@/types/stage-session'
import type { AttachedAgent, ReconciledItem, StageEntry, WorkSession } from '@/types/state'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo-1' as RepoId
const ISSUE_TARGETS = [
  { number: 46, kind: 'issue' as const },
  { number: 47, kind: 'pull-request' as const },
]

function item(kind: 'issue' | 'pull-request', number: number, extra: { stageHistory?: readonly StageEntry[]; workSessions?: readonly WorkSession[]; agents?: readonly AttachedAgent[] } = {}): ReconciledItem {
  return { kind, number, stageHistory: [], workSessions: [], agents: [], ...extra } as unknown as ReconciledItem
}

function entry(overrides: Partial<SessionIndexEntry> & { claudeSessionId: string }): SessionIndexEntry {
  return { repoId: REPO, cwd: '/w', branch: null, title: null, stage: null, startedAt: '2026-01-01T01:00:00.000Z', endedAt: '2026-01-01T01:30:00.000Z', costUsd: 1, operatorJoinedAt: null, ...overrides }
}

function tag(agent: StageTag['agent'], number: number, kind: StageTag['kind'], trigger: StageTag['trigger']): StageTag {
  return { agent, number, kind, trigger }
}

function snapshot(overrides: Partial<HostedSessionSnapshot>): HostedSessionSnapshot {
  return { sessionKey: 'hosted-1' as SessionKey, claudeSessionId: null, repoId: REPO, phase: 'streaming', startedAt: '2026-01-01T03:00:00.000Z', title: null, usage: null, stage: null, operatorJoinedAt: null, ...overrides } as HostedSessionSnapshot
}

function work(sessionId: string, lastActivityAt: string): WorkSession {
  return { sessionId, title: 'mine', lastActivityAt, activity: 'dormant', match: 'worktree' }
}

const issue = item('issue', 46)
const pr = item('pull-request', 47)

function run(overrides: Partial<Parameters<typeof ticketSessionsFor>[0]> = {}) {
  return ticketSessionsFor({ repoId: REPO, targets: ISSUE_TARGETS, index: [], snapshots: [], issue, pullRequest: pr, ...overrides })
}

describe('ticketSessionsFor', () => {
  it('places a stage session in the phase of its trigger, with refreshBranch landing in Merge', () => {
    const result = run({
      index: [
        entry({ claudeSessionId: 'plan', stage: tag('plan', 46, 'issue', 'ready') }),
        entry({ claudeSessionId: 'refresh', stage: tag('revise', 47, 'pull-request', 'refreshBranch') }),
      ],
    })
    expect(result.byPhase.plan?.map((l) => l.key)).toEqual(['plan'])
    expect(result.byPhase.merge?.map((l) => l.key)).toEqual(['refresh'])
    expect(result.byPhase.plan?.[0]).toMatchObject({ who: { kind: 'stage', agent: 'plan' }, state: 'ended', costUsd: 1, open: { kind: 'transcript', sessionId: 'plan', agentId: null } })
  })

  it('maps a terminal-dispatched agent by its agent and opens its transcript', () => {
    const agent = { agentId: 'a1', agentType: 'port:impl-agent', stage: 'impl-agent', lastActivityAt: '2026-01-01T02:00:00.000Z', sessionId: 'cockpit-1' } as AttachedAgent
    const result = ticketSessionsFor({ repoId: REPO, targets: ISSUE_TARGETS, index: [], snapshots: [], issue: item('issue', 46, { agents: [agent] }), pullRequest: pr })
    expect(result.byPhase.implement).toEqual([
      expect.objectContaining({ state: 'seen', who: { kind: 'stage', agent: 'impl' }, open: { kind: 'transcript', sessionId: 'cockpit-1', agentId: 'a1' } }),
    ])
  })

  it('lets a live snapshot beat its index entry and carries the live cost', () => {
    const result = run({
      index: [entry({ claudeSessionId: 'impl', endedAt: null, costUsd: 0.1, stage: tag('impl', 46, 'issue', 'planApproved') })],
      snapshots: [snapshot({ claudeSessionId: 'impl', stage: tag('impl', 46, 'issue', 'planApproved'), usage: { costUsd: 0.42 } as HostedSessionSnapshot['usage'] })],
    })
    expect(result.byPhase.implement).toEqual([expect.objectContaining({ state: 'live', costUsd: 0.42, endedAt: null, open: { kind: 'session', sessionKey: 'hosted-1' } })])
  })

  it('lists a live stage snapshot that has no claudeSessionId yet', () => {
    const result = run({ snapshots: [snapshot({ stage: tag('plan', 46, 'issue', 'ready') })] })
    expect(result.byPhase.plan).toHaveLength(1)
    expect(result.byPhase.plan?.[0]?.state).toBe('live')
  })

  it('reports an index entry with no end and no live handle as started', () => {
    const result = run({ index: [entry({ claudeSessionId: 'crashed', endedAt: null, stage: tag('impl', 46, 'issue', 'planApproved') })] })
    expect(result.byPhase.implement?.[0]?.state).toBe('started')
  })

  it('places a manual session by the merged issue and pull request history', () => {
    const history = (key: StageEntry['key'], at: string): StageEntry => ({ key, actor: null, at })
    const result = ticketSessionsFor({
      repoId: REPO,
      targets: ISSUE_TARGETS,
      index: [],
      snapshots: [],
      issue: item('issue', 46, { stageHistory: [history('planning', '2026-01-01T00:00:00.000Z'), history('prOpened', '2026-01-01T01:00:00.000Z')] }),
      pullRequest: item('pull-request', 47, {
        stageHistory: [history('needsRevision', '2026-01-01T02:00:00.000Z'), history('revising', '2026-01-01T03:00:00.000Z')],
        workSessions: [work('manual', '2026-01-01T03:30:00.000Z')],
      }),
    })
    expect(result.byPhase.revision?.map((l) => l.key)).toEqual(['manual'])
    expect(result.byPhase.revision?.[0]).toMatchObject({ who: { kind: 'you' }, state: 'seen', costUsd: null })
    expect(result.unplaced).toEqual([])
  })

  it('puts a manual session from before any history into unplaced', () => {
    const result = ticketSessionsFor({
      repoId: REPO,
      targets: ISSUE_TARGETS,
      index: [],
      snapshots: [],
      issue: item('issue', 46, { stageHistory: [{ key: 'planning', actor: null, at: '2026-01-02T00:00:00.000Z' }], workSessions: [work('early', '2026-01-01T00:00:00.000Z')] }),
      pullRequest: null,
    })
    expect(result.unplaced.map((l) => l.key)).toEqual(['early'])
  })

  it('lists an id that is both a stage session and a work session once, as the stage link', () => {
    const result = ticketSessionsFor({
      repoId: REPO,
      targets: ISSUE_TARGETS,
      index: [entry({ claudeSessionId: 'both', stage: tag('plan', 46, 'issue', 'ready') })],
      snapshots: [],
      issue: item('issue', 46, { workSessions: [work('both', '2026-01-01T01:10:00.000Z')] }),
      pullRequest: null,
    })
    const all = [...Object.values(result.byPhase).flat(), ...result.unplaced]
    expect(all).toHaveLength(1)
    expect(all[0]?.who).toEqual({ kind: 'stage', agent: 'plan' })
  })

  it('lets an index entry replace a scanned manual session’s time and cost', () => {
    const result = ticketSessionsFor({
      repoId: REPO,
      targets: ISSUE_TARGETS,
      index: [entry({ claudeSessionId: 'mine', startedAt: '2026-01-01T00:30:00.000Z', endedAt: '2026-01-01T00:40:00.000Z', costUsd: 2 })],
      snapshots: [],
      issue: item('issue', 46, { workSessions: [work('mine', '2026-01-01T05:00:00.000Z')] }),
      pullRequest: null,
    })
    expect(result.unplaced[0]).toMatchObject({ state: 'ended', at: '2026-01-01T00:30:00.000Z', costUsd: 2 })
  })

  it('ignores another repository’s index entries', () => {
    const result = run({ index: [entry({ claudeSessionId: 'other', repoId: 'repo-2' as RepoId, stage: tag('plan', 46, 'issue', 'ready') })] })
    expect(result.byPhase).toEqual({})
  })

  it('orders links within a phase oldest first', () => {
    const result = run({
      index: [
        entry({ claudeSessionId: 'late', startedAt: '2026-01-01T05:00:00.000Z', stage: tag('plan', 46, 'issue', 'ready') }),
        entry({ claudeSessionId: 'early', startedAt: '2026-01-01T01:00:00.000Z', stage: tag('plan', 46, 'issue', 'planChangesRequested') }),
      ],
    })
    expect(result.byPhase.plan?.map((l) => l.key)).toEqual(['early', 'late'])
  })
})

import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { PipelineFetch, PipelineItem } from '../../shared/github/types'
import type { RepositoryEntry } from '../../shared/repos'
import type { WorktreesRead } from '../../shared/local/types'
import type { AgentRecord, SessionRecord } from '../../shared/sessions/types'
import { reconcileRepository, type RepoSessionSlice } from './reconcile'

const VOCABULARY = resolveVocabulary({})

function entry(): Extract<RepositoryEntry, { status: 'ready' }> {
  return {
    id: 'repo-1' as RepositoryEntry['id'],
    path: '/repo',
    displayName: 'o/r',
    status: 'ready',
    config: {
      repo: 'o/r',
      owner: 'o',
      name: 'r',
      branches: { integration: 'dev', production: 'main' },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: VOCABULARY,
    },
    diagnostics: [],
  }
}

function item(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    repo: 'o/r',
    kind: 'issue',
    number: 79,
    title: 'a ticket',
    url: 'https://github.com/o/r/issues/79',
    body: 'body text',
    state: 'OPEN',
    mergedAt: null,
    assignees: ['op'],
    labels: ['ready'],
    matchedKeys: ['ready'],
    ...overrides,
  }
}

function fetchOf(items: readonly PipelineItem[]): PipelineFetch {
  return {
    ok: true,
    items,
    queried: [],
    disabled: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' },
    fetchedAt: '2026-01-01T00:00:00Z',
  }
}

function worktreesOf(): WorktreesRead {
  return { ok: true, mainPath: '/repo', entries: [], subjectsAvailable: true, readAt: '2026-01-01T00:00:00Z' }
}

function denialsOf() {
  return { ok: true as const, present: false as const, path: '/repo/.agents/denials.log', readAt: '2026-01-01T00:00:00Z' }
}

function sessionsOf(overrides: Partial<RepoSessionSlice> = {}): RepoSessionSlice {
  return { agents: [], sessions: [], available: true, freshness: { at: '2026-01-01T00:00:00Z' }, ...overrides }
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    sessionId: 's1',
    repoId: 'repo-1' as AgentRecord['repoId'],
    agentId: 'a1',
    agentType: 'port:impl-agent',
    stage: 'impl-agent',
    model: 'sonnet',
    description: 'impl #79',
    itemNumber: 79,
    worktreePath: null,
    worktreeBranch: null,
    spawnDepth: 1,
    lastActivityAt: '2026-01-01T00:00:00Z',
    idleMs: 0,
    activity: 'active',
    ...overrides,
  }
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'sess1',
    repoId: 'repo-1' as SessionRecord['repoId'],
    cwd: '/repo/.claude/worktrees/impl-79',
    worktreePath: '/repo/.claude/worktrees/impl-79',
    role: 'implement',
    roleEvidence: 'worktree-name',
    itemNumber: 79,
    customTitle: null,
    summary: null,
    firstPrompt: null,
    gitBranch: null,
    lastActivityAt: '2026-01-01T00:00:00Z',
    idleMs: 0,
    activity: 'active',
    agentIds: [],
    ...overrides,
  }
}

function reconcile(items: readonly PipelineItem[], overrides: Partial<{ repoSessions: RepoSessionSlice; worktrees: WorktreesRead }> = {}) {
  return reconcileRepository({
    entry: entry(),
    pipelineFetch: fetchOf(items),
    itemsByNumberFetch: null,
    repoSessions: sessionsOf(overrides.repoSessions),
    worktrees: overrides.worktrees ?? worktreesOf(),
    denials: denialsOf(),
  })
}

describe('reconcileRepository — status table', () => {
  it('trigger → waiting', () => {
    const state = reconcile([item({ matchedKeys: ['ready'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('waiting')
  })

  it('gate → gated', () => {
    const state = reconcile([item({ matchedKeys: ['blocked'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('gated')
  })

  it('terminal → terminal', () => {
    const state = reconcile([item({ matchedKeys: ['prOpened'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('terminal')
  })

  it('unstaged (markers only) → unstaged', () => {
    const state = reconcile([item({ matchedKeys: ['marker'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('unstaged')
  })

  it('in-flight, sessions unavailable → in-flight/sessions-unavailable', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ available: false, freshness: { unavailable: 'x' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('sessions-unavailable')
  })

  it('in-flight, an active agent attached → in-flight/agent-active', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ agents: [agent({ activity: 'active' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('agent-active')
  })

  it('in-flight, no agent but an active implement session → in-flight/session-active (Decision 3)', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ sessions: [session({ activity: 'active' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('session-active')
  })

  it('in-flight, every attachment dormant → stalled/all-dormant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ agents: [agent({ activity: 'dormant' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('all-dormant')
  })

  it('in-flight, no attachment at all → stalled/no-claimant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })
})

describe('reconcileRepository — waitingOn', () => {
  it('an unassigned trigger item reports waitingOn: nobody', () => {
    const state = reconcile([item({ matchedKeys: ['ready'], assignees: [] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.waitingOn).toBe('nobody')
  })

  it('a session-required trigger item reports waitingOn: operator-session', () => {
    const body = ['---', '', '## Implementation Plan', '', "> **SESSION REQUIRED:** touches `.claude/**`"].join('\n')
    const state = reconcile([item({ matchedKeys: ['ready'], body })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.sessionRequired).toBe(true)
    expect(state.items[0]?.waitingOn).toBe('operator-session')
  })

  it('an ordinary assigned trigger item reports waitingOn: cockpit', () => {
    const state = reconcile([item({ matchedKeys: ['ready'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.waitingOn).toBe('cockpit')
  })
})

describe('reconcileRepository — linking', () => {
  it('an issue at pr opened whose pull request is absent reports linkReason: counterpart-not-open, never a merge-pending claim', () => {
    const state = reconcile([item({ matchedKeys: ['prOpened'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('counterpart-not-open')
  })

  it('a pull request with no closing keyword reports linkReason: no-closing-keyword', () => {
    const state = reconcile([item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], body: 'no reference here' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('no-closing-keyword')
  })

  it('a pull request naming Closes #N links, and the issue links back', () => {
    const state = reconcile([
      item({ number: 79, matchedKeys: ['prOpened'] }),
      item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], body: 'Closes #79' }),
    ])
    if (!state.ok) throw new Error('unreachable')
    const issue = state.items.find((i) => i.number === 79)
    const pr = state.items.find((i) => i.number === 196)
    expect(pr?.linked).toBe(79)
    expect(issue?.linked).toBe(196)
    expect(issue?.linkReason).toBeNull()
  })
})

describe('reconcileRepository — failure paths', () => {
  it('a failed pipeline fetch never returns ok: true with an empty items array', () => {
    const state = reconcileRepository({
      entry: entry(),
      pipelineFetch: { ok: false, kind: 'network', message: 'boom', fetchedAt: '2026-01-01T00:00:00Z' },
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    expect(state.ok).toBe(false)
    if (state.ok) throw new Error('unreachable')
    expect(state.reason).toBe('github-unavailable')
    expect('items' in state).toBe(false)
  })
})

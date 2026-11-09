import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { PipelineFetch, PipelineItem } from '@/types/github'
import type { RepositoryEntry } from '@/utils/repos'
import type { WorktreeEntry, WorktreesRead } from '@/types/local'
import type { AgentRecord, SessionRecord } from '@/types/sessions'
import { reconcileRepository } from '@/main/state/reconcile'
import type { RepoSessionSlice } from '@/types/state'

const VOCABULARY = resolveVocabulary({})

export function entry(): Extract<RepositoryEntry, { status: 'ready' }> {
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
      commands: { worktrees: null, budget: null },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: VOCABULARY,
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
    },
    diagnostics: [],
  }
}

export function item(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    repo: 'o/r',
    kind: 'issue',
    number: 79,
    title: 'a ticket',
    url: 'https://github.com/o/r/issues/79',
    body: 'body text',
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    assignees: ['op'],
    labels: ['ready'],
    matchedKeys: ['ready'],
    labelEvents: [],
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    checkRollup: null,
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
    ...overrides,
  }
}

export function fetchOf(items: readonly PipelineItem[]): PipelineFetch {
  return {
    ok: true,
    items,
    queried: [],
    disabled: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z', limit: 5000 },
    viewer: 'op',
    integrationChecks: {},
    fetchedAt: '2026-01-01T00:00:00Z',
  }
}

export function worktreesOf(entries: readonly WorktreeEntry[] = []): WorktreesRead {
  return { ok: true, mainPath: '/repo', entries, subjectsAvailable: true, readAt: '2026-01-01T00:00:00Z' }
}

export function worktreeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: '/repo/.claude/worktrees/agent-1',
    isMain: false,
    branch: '79-a-ticket',
    head: 'abc123',
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    producer: 'dispatched',
    insideMain: true,
    correlation: { number: 79, rung: 'branch-name' },
    unresolved: null,
    ...overrides,
  }
}

export function denialsOf() {
  return { ok: true as const, present: false as const, path: '/repo/.agents/denials.log', readAt: '2026-01-01T00:00:00Z' }
}

export function sessionsOf(overrides: Partial<RepoSessionSlice> = {}): RepoSessionSlice {
  return { agents: [], sessions: [], available: true, freshness: { at: '2026-01-01T00:00:00Z' }, ...overrides }
}

export function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
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

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
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

export function reconcile(items: readonly PipelineItem[], overrides: Partial<{ repoSessions: RepoSessionSlice; worktrees: WorktreesRead }> = {}) {
  return reconcileRepository({
    entry: entry(),
    pipelineFetch: fetchOf(items),
    itemsByNumberFetch: null,
    repoSessions: sessionsOf(overrides.repoSessions),
    worktrees: overrides.worktrees ?? worktreesOf(),
    denials: denialsOf(),
  })
}

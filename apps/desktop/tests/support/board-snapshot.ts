import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import { ticketOf } from './tickets'

/** Board-side fixtures at their idle defaults; override only what a test reads. */
function defaultTicketOf(item: ReconciledItem): NonNullable<ReconciledItem['ticket']> {
  const repo = 'o/a' as NonNullable<ReconciledItem['ticket']>['repo']
  if (item.kind === 'pull-request') return ticketOf({ repo, ticket: item.linked ?? item.number, pr: { number: item.number, approvedAt: null }, stage: 'review', reviewCycles: item.reviewCycleCount ?? 0 })
  return ticketOf({ repo, ticket: item.number })
}

/** `ticket` defaults to a queued ticket at its first stage; pass `ticket: null` for an untracked item. */
export function reconciledItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  const item: ReconciledItem = reconciledItemBase(overrides)
  return 'ticket' in overrides ? item : { ...item, ticket: defaultTicketOf(item) }
}

function reconciledItemBase(overrides: Partial<ReconciledItem>): ReconciledItem {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: 'issue',
    number: 1,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/1',
    assignees: ['op'],
    ticket: null,
    status: 'waiting',
    statusEvidence: null,
    waitingOn: 'cockpit',
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    workSessions: [],
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
    ...overrides,
  }
}

export function repositoryState(
  items: readonly ReconciledItem[],
  overrides: Partial<Extract<RepositoryState, { readonly ok: true }>> = {},
  at = '2026-01-01T00:00:00Z',
): Extract<RepositoryState, { readonly ok: true }> {
  return {
    ok: true,
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    displayName: 'o/a',
    items,
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: at },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z', limit: 5000 },
    freshness: {
      github: { at },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at },
      worktrees: { at },
      denials: { at },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    integrationChecks: {},
    approvalGate: true,
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
    ...overrides,
  }
}

export function boardSnapshot(
  repositories: readonly RepositoryState[] = [],
  at = '2026-01-01T00:00:00Z',
  overrides: Partial<BoardSnapshot> = {},
): BoardSnapshot {
  return {
    state: { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: at }, readAt: at },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: at,
    dispatch: [],
    autoPlan: [],
    ...overrides,
  }
}

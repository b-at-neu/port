import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { PipelineState, ReconciledItem, RepositoryState } from '@/types/state'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS, initialHealth } from '@/types/board'
import type { BoardSnapshot, RepositoryHealth } from '@/types/board'
import { boardSignature, displayStatus, projectBoard, stageLabelOf } from '@/renderer/board/project'
import { stageSession } from '../../../fixtures/stage-session'

const NOW = new Date('2026-01-01T01:00:00.000Z')

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: 'issue',
    number: 1,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/1',
    assignees: ['op'],
    stage: 'trigger',
    stages: [{ key: 'ready', name: 'ready', role: 'trigger' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
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
    stageHistory: [],
    matchedKeys: ['ready'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    ...overrides,
  }
}

function readyRepo(overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    displayName: 'o/a',
    items: [],
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z', limit: 5000 },
    freshness: {
      github: { at: NOW.toISOString() },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
    ...overrides,
  }
}

function health(overrides: Partial<RepositoryHealth> = {}): RepositoryHealth {
  return { repoId: 'repo-a' as RepoId, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials'), ...overrides }
}

function snapshotOf(repositories: readonly RepositoryState[], healths: readonly RepositoryHealth[] = []): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return {
    state,
    health: healths,
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
    autoPlan: [],
  }
}

describe('displayStatus — Decision 5 suppression', () => {
  it('a non-stalled status passes through unchanged', () => {
    const result = displayStatus(item({ status: 'waiting' }), health(), readyRepo().freshness, NOW)
    expect(result).toEqual({ status: 'waiting', staleGithub: false, githubAgeMs: null })
  })

  it('renders stalled when the GitHub read is healthy and within the grace window', () => {
    const freshness = readyRepo().freshness
    const result = displayStatus(item({ status: 'stalled' }), health(), freshness, NOW)
    expect(result.status).toBe('stalled')
    expect(result.staleGithub).toBe(false)
  })

  it('suppresses to in-flight when the GitHub read has gone stale beyond the grace window', () => {
    const staleAt = new Date(NOW.getTime() - SOURCE_BASE_INTERVAL_MS.github - STALE_GRACE_MS - 1_000).toISOString()
    const freshness = { ...readyRepo().freshness, github: { at: staleAt } }
    const result = displayStatus(item({ status: 'stalled' }), health(), freshness, NOW)
    expect(result.status).toBe('in-flight')
    expect(result.staleGithub).toBe(true)
  })

  it('suppresses to in-flight when the GitHub source itself is unhealthy, even if the read is recent', () => {
    const unhealthy = health({ github: { ...initialHealth('github'), consecutiveFailures: 3 } })
    const result = displayStatus(item({ status: 'stalled' }), unhealthy, readyRepo().freshness, NOW)
    expect(result.status).toBe('in-flight')
    expect(result.staleGithub).toBe(true)
  })

  it('suppresses to in-flight when the GitHub source has never read at all', () => {
    const freshness = { ...readyRepo().freshness, github: { unavailable: 'gh not authenticated' } }
    const result = displayStatus(item({ status: 'stalled' }), health(), freshness, NOW)
    expect(result.status).toBe('in-flight')
    expect(result.githubAgeMs).toBeNull()
  })

  it('the boundary is inclusive — exactly interval + grace still reads as stalled', () => {
    const boundaryAt = new Date(NOW.getTime() - SOURCE_BASE_INTERVAL_MS.github - STALE_GRACE_MS).toISOString()
    const freshness = { ...readyRepo().freshness, github: { at: boundaryAt } }
    const result = displayStatus(item({ status: 'stalled' }), health(), freshness, NOW)
    expect(result.status).toBe('stalled')
  })

  it('a stall read 3 minutes ago, under a 5-minute stretched interval, still renders stalled', () => {
    const stretched = health({ github: { ...initialHealth('github'), intervalMs: 300_000 } })
    const freshness = { ...readyRepo().freshness, github: { at: new Date(NOW.getTime() - 180_000).toISOString() } }
    expect(displayStatus(item({ status: 'stalled' }), stretched, freshness, NOW).status).toBe('stalled')
    expect(displayStatus(item({ status: 'stalled' }), health(), freshness, NOW).status).toBe('in-flight')
  })
})

describe('stageLabelOf', () => {
  it('returns the stage label whose role matches the winning stage', () => {
    const label = stageLabelOf(item({ stage: 'trigger', stages: [{ key: 'ready', name: 'ready', role: 'trigger' }] }))
    expect(label?.key).toBe('ready')
  })

  it('returns null when stage is null', () => {
    expect(stageLabelOf(item({ stage: null, stages: [] }))).toBeNull()
  })
})

describe('projectBoard — grouping', () => {
  it('groups by stage, in LABEL_DEFAULTS order, omitting empty groups', () => {
    const repo = readyRepo({ items: [item({ number: 1, stage: 'trigger', stages: [{ key: 'ready', name: 'ready', role: 'trigger' }], status: 'waiting' })] })
    const projection = projectBoard({ snapshot: snapshotOf([repo], [health()]), groupBy: 'stage', now: NOW })
    expect(projection.groups).toHaveLength(1)
    expect(projection.groups[0]?.key).toBe('ready')
    expect(projection.groups[0]?.rows).toHaveLength(1)
  })

  it('groups by repo when requested, two repositories renaming the same label differently still share one stage group', () => {
    const vocabA = resolveVocabulary({ labels: { ready: 'triage' } })
    const vocabB = resolveVocabulary({ labels: { ready: 'todo' } })
    const repoA = readyRepo({ repoId: 'repo-a' as RepoId, displayName: 'o/a', vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } }, items: [item({ repoId: 'repo-a' as RepoId, number: 1 })] })
    const repoB = readyRepo({ repoId: 'repo-b' as RepoId, displayName: 'o/b', items: [item({ repoId: 'repo-b' as RepoId, number: 2 })] })
    void vocabA
    void vocabB

    const byStage = projectBoard({ snapshot: snapshotOf([repoA, repoB], [health(), health({ repoId: 'repo-b' as RepoId })]), groupBy: 'stage', now: NOW })
    expect(byStage.groups).toHaveLength(1)
    expect(byStage.groups[0]?.rows).toHaveLength(2)

    const byRepo = projectBoard({ snapshot: snapshotOf([repoA, repoB], [health(), health({ repoId: 'repo-b' as RepoId })]), groupBy: 'repo', now: NOW })
    expect(byRepo.groups).toHaveLength(2)
  })

  it('sorts rows by repository display name, then number ascending, stably across two projections', () => {
    const repo = readyRepo({ items: [item({ number: 5 }), item({ number: 1 }), item({ number: 3 })] })
    const snapshot = snapshotOf([repo], [health()])
    const first = projectBoard({ snapshot, groupBy: 'stage', now: NOW })
    const second = projectBoard({ snapshot, groupBy: 'stage', now: NOW })
    expect(first.groups[0]?.rows.map((r) => r.item.number)).toEqual([1, 3, 5])
    expect(second.groups[0]?.rows.map((r) => r.item.number)).toEqual([1, 3, 5])
  })

  it('carries a not-ready repository into the projection rather than dropping it', () => {
    const notReady: RepositoryState = { ok: false, repoId: 'repo-bad' as RepoId, displayName: 'o/bad', reason: 'not-ready', problem: { kind: 'not-a-git-repository' } }
    const projection = projectBoard({ snapshot: snapshotOf([notReady], []), groupBy: 'stage', now: NOW })
    expect(projection.notReady).toHaveLength(1)
  })
})

describe('projectBoard — one row per ticket', () => {
  const REVIEWING = { stage: 'trigger', stages: [{ key: 'reviewing', name: 'reviewing', role: 'trigger' }], status: 'in-flight' } as const
  const linkedPair = (issueOverrides: Partial<ReconciledItem> = {}) => [
    item({ number: 464, title: 'the ticket', stage: null, stages: [], status: 'unstaged', linked: 537, ...issueOverrides }),
    item({ number: 537, kind: 'pull-request', title: 'the pull request', url: 'https://github.com/o/a/pull/537', linked: 464, ...REVIEWING }),
  ]
  const project = (items: readonly ReconciledItem[], sessions: Parameters<typeof projectBoard>[0]['sessions'] = []) =>
    projectBoard({ snapshot: snapshotOf([readyRepo({ items })], [health()]), groupBy: 'stage', now: NOW, sessions })

  it('shows an unlabelled issue and its reviewing pull request as one row with the review status, never Unstaged', () => {
    const projection = project(linkedPair())
    expect(projection.rows).toHaveLength(1)
    const [row] = projection.rows
    expect(row?.ticket.ref).toMatchObject({ kind: 'issue', number: 464, title: 'the ticket', pullRequest: { number: 537 } })
    expect(row?.item.number).toBe(537)
    expect(row?.stageLabel?.key).toBe('reviewing')
    expect(row?.displayStatus.status).toBe('in-flight')
    expect(projection.groups.map((group) => group.key)).toEqual(['reviewing'])
  })

  it('keeps a pull request with no ticket as a row of its own, keyed as a pull request', () => {
    const [row] = project([item({ number: 35, kind: 'pull-request', linked: null })]).rows
    expect(row?.ticket.ref.kind).toBe('unlinked-pr')
    expect(row?.ticket.ref.number).toBe(35)
  })

  it('marks the row interrupted when either the issue or the pull request is', () => {
    const snapshot = snapshotOf([readyRepo({ items: linkedPair() })], [health()])
    const interrupted = { repoId: 'repo-a' as RepoId, number: 464 }
    const withInterrupted = { ...snapshot, dispatch: [{ repoId: 'repo-a' as RepoId, interrupted: [interrupted] }] } as unknown as BoardSnapshot
    expect(projectBoard({ snapshot: withInterrupted, groupBy: 'stage', now: NOW }).rows[0]?.displayStatus.status).toBe('interrupted')
  })

  it("matches a live session on either of the ticket's numbers", () => {
    const review = stageSession({ repoId: 'repo-a' as RepoId, key: 'hosted-review', stage: { agent: 'review', number: 537, kind: 'pull-request', trigger: 'readyForReview' } })
    expect(project(linkedPair(), [review]).rows[0]?.liveStage?.sessionKey).toBe('hosted-review')
    const plan = stageSession({ repoId: 'repo-a' as RepoId, key: 'hosted-plan', stage: { agent: 'plan', number: 464, kind: 'issue', trigger: 'ready' } })
    expect(project(linkedPair(), [plan]).rows[0]?.liveStage?.sessionKey).toBe('hosted-plan')
  })

  it('stamps autoApproving from the snapshot list, by repository and number', () => {
    const snapshot = { ...snapshotOf([readyRepo({ items: [item({ number: 5 }), item({ number: 6 })] })], [health()]), autoPlan: [{ repoId: 'repo-a' as RepoId, approving: [5] }] }
    const rows = projectBoard({ snapshot, groupBy: 'stage', now: NOW }).rows
    expect(rows.map((row) => [row.item.number, row.autoApproving])).toEqual([[5, true], [6, false]])
  })

  it('ignores an approving number listed under another repository', () => {
    const snapshot = { ...snapshotOf([readyRepo({ items: [item({ number: 5 })] })], [health()]), autoPlan: [{ repoId: 'repo-b' as RepoId, approving: [5] }] }
    expect(projectBoard({ snapshot, groupBy: 'stage', now: NOW }).rows[0]?.autoApproving).toBe(false)
  })

  it('sorts rows by the ticket number', () => {
    const rows = project([item({ number: 9 }), ...linkedPair(), item({ number: 700 })]).rows
    expect(rows.map((row) => row.ticket.ref.number)).toEqual([9, 464, 700])
  })
})

describe('projectBoard — live stage sessions', () => {
  const REPO = 'repo-a' as RepoId
  const planSession = (overrides: Partial<Parameters<typeof stageSession>[0]> = {}) =>
    stageSession({ repoId: REPO, stage: { agent: 'plan', number: 1, kind: 'issue', trigger: 'ready' }, ...overrides })
  const project = (items: readonly ReconciledItem[], sessions: Parameters<typeof projectBoard>[0]['sessions']) =>
    projectBoard({ snapshot: snapshotOf([readyRepo({ items })], [health()]), groupBy: 'stage', now: NOW, sessions })

  it('marks a queued item with a streaming stage session as in flight, with liveStage set', () => {
    const [row] = project([item()], [planSession({ key: 'hosted-plan' })]).rows
    expect(row?.liveStage).toEqual({ agent: 'plan', trigger: 'ready', sessionKey: 'hosted-plan' })
    expect(row?.displayStatus.status).toBe('in-flight')
    expect(row?.item.status).toBe('waiting')
  })

  it.each([['ended'], ['closing']] as const)('ignores a %s session', (phase) => {
    const [row] = project([item()], [planSession({ phase })]).rows
    expect(row?.liveStage).toBeNull()
    expect(row?.displayStatus.status).toBe('waiting')
  })

  it.each([['ready'], ['interrupting']] as const)('keeps a waiting item waiting while its %s session is not working, liveStage still set', (phase) => {
    const [row] = project([item()], [planSession({ phase })]).rows
    expect(row?.liveStage).not.toBeNull()
    expect(row?.displayStatus.status).toBe('waiting')
  })

  it('does not match a session for the same number of the other kind', () => {
    const session = planSession({ stage: { agent: 'plan', number: 1, kind: 'pull-request', trigger: 'ready' } })
    expect(project([item()], [session]).rows[0]?.liveStage).toBeNull()
  })

  it('does not match a session from another repository', () => {
    expect(project([item()], [planSession({ repoId: 'repo-b' as RepoId })]).rows[0]?.liveStage).toBeNull()
  })

  it('keeps the newest of two live sessions for one item', () => {
    const older = planSession({ key: 'older', startedAt: '2026-01-01T00:00:00.000Z' })
    const newer = planSession({ key: 'newer', startedAt: '2026-01-01T00:30:00.000Z' })
    expect(project([item()], [newer, older]).rows[0]?.liveStage?.sessionKey).toBe('newer')
  })

  it('leaves an in-flight item in flight, with liveStage still set', () => {
    const inFlight = item({ status: 'in-flight', stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }] })
    const [row] = project([inFlight], [planSession()]).rows
    expect(row?.displayStatus.status).toBe('in-flight')
    expect(row?.liveStage).not.toBeNull()
  })

  it('defaults to no sessions', () => {
    expect(project([item()], undefined).rows[0]?.liveStage).toBeNull()
  })

  it('refuses unblock with agent-live for a blocked issue that has a live session', () => {
    const blocked = item({ status: 'gated', stage: 'gate', stages: [{ key: 'blocked', name: 'blocked', role: 'gate' }] })
    expect(project([blocked], [planSession()]).rows[0]?.decisions.unblock).toEqual({ available: false, reason: 'agent-live' })
    expect(project([blocked], []).rows[0]?.decisions.unblock).toMatchObject({ available: true })
  })
})

describe('projectBoard — denial burst (Decision 7)', () => {
  it('surfaces the burst copy from #85\'s inspector on the repo group heading, never a line total', () => {
    const entries = [0, 1, 2].map((i) => ({
      raw: 'line',
      form: 'current' as const,
      timestamp: new Date(NOW.getTime() - (2 - i) * 60_000).toISOString(),
      decision: 'deny' as const,
      actor: { kind: 'stage-agent' as const, agent: 'impl-agent' as const },
      subject: 'git push origin main',
    }))
    const denials = {
      ok: true as const,
      present: true as const,
      path: '/repo/.agents/denials.log',
      entries,
      summary: { agentDenials: 3, railDenials: 0, misses: 0, gateClears: 0, hookErrors: 0, legacy: 0, malformed: 0, total: 3 },
      capped: false,
      readAt: NOW.toISOString(),
    }
    const repo = readyRepo({ denials, items: [item()] })
    const projection = projectBoard({ snapshot: snapshotOf([repo], [health()]), groupBy: 'repo', now: NOW })
    expect(projection.repositorySummaries[0]?.denialBurst).toBe('3 denials on one command in 2m')
  })

  it('no burst on a quiet log', () => {
    const repo = readyRepo({ items: [item()] })
    const projection = projectBoard({ snapshot: snapshotOf([repo], [health()]), groupBy: 'repo', now: NOW })
    expect(projection.repositorySummaries[0]?.denialBurst).toBeNull()
  })
})

describe('boardSignature — Decision 1 no-op guard', () => {
  it('changes when a rendered field changes', () => {
    const repoQuiet = readyRepo({ items: [item({ status: 'waiting' })] })
    const repoChanged = readyRepo({ items: [item({ status: 'gated', stage: 'gate', stages: [{ key: 'blocked', name: 'blocked', role: 'gate' }] })] })
    const a = projectBoard({ snapshot: snapshotOf([repoQuiet], [health()]), groupBy: 'stage', now: NOW })
    const b = projectBoard({ snapshot: snapshotOf([repoChanged], [health()]), groupBy: 'stage', now: NOW })
    expect(boardSignature(a)).not.toBe(boardSignature(b))
  })

  it('does not change when only emittedAt changes', () => {
    const repo = readyRepo({ items: [item()] })
    const snapshotEarly = snapshotOf([repo], [health()])
    const snapshotLate = { ...snapshotEarly, emittedAt: '2026-01-01T09:00:00.000Z' }
    const a = projectBoard({ snapshot: snapshotEarly, groupBy: 'stage', now: NOW })
    const b = projectBoard({ snapshot: snapshotLate, groupBy: 'stage', now: NOW })
    expect(boardSignature(a)).toBe(boardSignature(b))
  })
})

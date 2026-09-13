import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../labels/vocabulary'
import type { RepoId } from '../repos'
import type { PipelineState, ReconciledItem, RepositoryState } from '../state/types'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS, initialHealth } from './types'
import type { BoardSnapshot, RepositoryHealth } from './types'
import { boardSignature, displayStatus, projectBoard, stageLabelOf } from './project'

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
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['ready'],
    sources: ['github'],
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
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z' },
    freshness: {
      github: { at: NOW.toISOString() },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    ...overrides,
  }
}

function health(overrides: Partial<RepositoryHealth> = {}): RepositoryHealth {
  return { repoId: 'repo-a' as RepoId, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials'), ...overrides }
}

function snapshotOf(repositories: readonly RepositoryState[], healths: readonly RepositoryHealth[] = []): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return { state, health: healths, policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS }, emittedAt: NOW.toISOString() }
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

import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PipelineState, ReconciledItem, RepositoryState } from '@/types/state'
import type { TickReport } from '@/types/tick'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '@/types/board'
import type { BoardSnapshot } from '@/types/board'
import { needsYouCount, needsYouItems, repoNeedsYou } from '@/renderer/board/needs-you'

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
    stage: 'gate',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'gated',
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
    updatedAt: null,
    stageHistory: [],
    matchedKeys: ['planReview'],
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
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z' },
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

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return {
    repoId: 'repo-a' as RepoId,
    displayName: 'o/a',
    blind: null,
    actionable: [],
    held: [],
    claims: [],
    autoApprovals: [],
    disabledStages: [],
    nextTickAt: null,
    observations: [],
    labelRepairs: [],
    ...overrides,
  }
}

function dispatchStatus(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return {
    repoId: 'repo-a' as RepoId,
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
  }
}

function snapshotOf(repositories: readonly RepositoryState[], overrides: Partial<Pick<BoardSnapshot, 'tick' | 'dispatch'>> = {}): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return {
    state,
    health: [],
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
    ...overrides,
  }
}

describe('needsYouItems', () => {
  it('each stage key surfaces as its own kind', () => {
    const cases: readonly [ReconciledItem['stage'], string, string][] = [
      ['gate', 'planReview', 'plan-review'],
      ['terminal', 'approved', 'ready-to-merge'],
      ['gate', 'needsHuman', 'needs-human'],
      ['gate', 'blocked', 'blocked'],
    ]
    for (const [role, key, kind] of cases) {
      const repo = readyRepo({ items: [item({ stage: role, stages: [{ key: key as never, name: key, role: role as never }] })] })
      const items = needsYouItems(snapshotOf([repo]), NOW)
      expect(items).toHaveLength(1)
      expect(items[0]?.kind).toBe(kind)
    }
  })

  it('a stage key with no mapped kind is excluded', () => {
    const repo = readyRepo({ items: [item({ stage: 'trigger', stages: [{ key: 'ready', name: 'ready', role: 'trigger' }] })] })
    expect(needsYouItems(snapshotOf([repo]), NOW)).toEqual([])
  })

  it('excludes an item not assigned to a known viewer', () => {
    const repo = readyRepo({ viewer: 'op', items: [item({ assignees: ['someone-else'] })] })
    expect(needsYouItems(snapshotOf([repo]), NOW)).toEqual([])
  })

  it('includes an item regardless of assignees when the viewer is null', () => {
    const repo = readyRepo({ viewer: null, items: [item({ assignees: ['someone-else'] })] })
    expect(needsYouItems(snapshotOf([repo]), NOW)).toHaveLength(1)
  })

  it('held items keep only conflicting, contended and cycle-cap', () => {
    const held = [
      { number: 1, kind: 'pull-request' as const, trigger: 'readyForReview' as const, reason: 'conflicting' as const, contention: null, escalation: null },
      { number: 2, kind: 'pull-request' as const, trigger: 'readyForReview' as const, reason: 'unowned' as const, contention: null, escalation: null },
    ]
    const items = needsYouItems(snapshotOf([], { tick: [tickReport({ held })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'held', number: 1 })
  })

  it('claims keep only stalled-confirmed', () => {
    const claims = [
      { number: 3, kind: 'issue' as const, inFlight: 'inProgress' as const, class: 'stalled-confirmed' as const, retryKey: 'inProgress' as const },
      { number: 4, kind: 'issue' as const, inFlight: 'inProgress' as const, class: 'matched' as const, retryKey: null },
    ]
    const items = needsYouItems(snapshotOf([], { tick: [tickReport({ claims })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stalled', number: 3 })
  })

  it('surfaces every reported labelRepair as a half-labelled item', () => {
    const labelRepairs = [{ number: 9, kind: 'issue' as const, shape: 'contradictory' as const, labels: ['planning' as const, 'planReview' as const], agent: null }]
    const items = needsYouItems(snapshotOf([], { tick: [tickReport({ labelRepairs })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'half-labelled', number: 9 })
  })

  it('budget notes keep only escalated and escalation-failed', () => {
    const dispatch = [
      dispatchStatus({ budget: { line: null, problem: null, costUsd: null, notes: [{ kind: 'escalated', number: 5, needsHumanLabel: 'needs human', commentFailedMessage: null }] } }),
      dispatchStatus({ repoId: 'repo-b' as RepoId, budget: { line: null, problem: null, costUsd: null, notes: [{ kind: 'held', number: 6, line: 'held' }] } }),
    ]
    const items = needsYouItems(snapshotOf([], { dispatch }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'budget', number: 5 })
  })

  it('derives a stage-denial item from dispatch[].denials', () => {
    const denial = { id: 'd1', repoId: 'repo-a' as RepoId, agent: 'impl' as const, number: 300, toolName: 'Bash', inputSummary: 'pnpm exec playwright test', rule: 'Bash(pnpm *)', at: NOW.toISOString() }
    const items = needsYouItems(snapshotOf([], { dispatch: [dispatchStatus({ denials: [denial] })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-denial', number: 300 })
  })

  it('derives a stage-interrupted item from dispatch[].interrupted', () => {
    const interrupted = {
      id: 'i1',
      repoId: 'repo-a' as RepoId,
      agent: 'plan' as const,
      number: 301,
      kind: 'issue' as const,
      trigger: 'ready' as const,
      inFlight: 'planning' as const,
      model: 'opus',
      claudeSessionId: null,
      worktree: { path: '/wt', branch: 'b', baseSha: 's' },
      startedAt: NOW.toISOString(),
      reason: 'usage-limit' as const,
      detail: null,
      resetsAt: '2026-01-01T15:00:00.000Z',
      costUsd: null,
    }
    const items = needsYouItems(snapshotOf([], { dispatch: [dispatchStatus({ interrupted: [interrupted] })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-interrupted', number: 301 })
  })

  it('a hand-back with a preamble before BLOCKED: yields one stage-blocked item', () => {
    const session = {
      sessionKey: 'hosted-2' as SessionKey,
      claudeSessionId: 's2',
      repoId: 'repo-a' as RepoId,
      workspace: { folder: '/wt', root: '/repo', worktree: null, base: null },
      phase: 'streaming' as const,
      origin: { kind: 'fresh' as const },
      startedAt: NOW.toISOString(),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities: { kind: 'pending' as const, request: { source: 'installed' as const } },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default' as const, model: null, effort: null },
      models: { kind: 'pending' as const },
      usage: null,
      backgroundTasks: [],
      stage: { agent: 'impl' as const, number: 302, kind: 'issue' as const, trigger: 'planApproved' as const },
      lastResult: { subtype: 'success', isError: false, text: 'Did some work.\n\nBLOCKED: denied gh api', at: NOW.toISOString() },
      operatorJoinedAt: null,
    }
    const items = needsYouItems(snapshotOf([]), NOW, [session])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-blocked', number: 302 })
  })

  it('an error-result hand-back does not produce a stage-blocked item', () => {
    const session = {
      sessionKey: 'hosted-4' as SessionKey,
      claudeSessionId: 's4',
      repoId: 'repo-a' as RepoId,
      workspace: { folder: '/wt', root: '/repo', worktree: null, base: null },
      phase: 'streaming' as const,
      origin: { kind: 'fresh' as const },
      startedAt: NOW.toISOString(),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities: { kind: 'pending' as const, request: { source: 'installed' as const } },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default' as const, model: null, effort: null },
      models: { kind: 'pending' as const },
      usage: null,
      backgroundTasks: [],
      stage: { agent: 'impl' as const, number: 304, kind: 'issue' as const, trigger: 'planApproved' as const },
      lastResult: { subtype: 'error_during_execution', isError: true, text: 'BLOCKED: denied gh api', at: NOW.toISOString() },
      operatorJoinedAt: null,
    }
    const items = needsYouItems(snapshotOf([]), NOW, [session])
    expect(items).toEqual([])
  })

  it('a mid-message mention of the questions prefix does not produce a stage-questions item', () => {
    const session = {
      sessionKey: 'hosted-3' as SessionKey,
      claudeSessionId: 's3',
      repoId: 'repo-a' as RepoId,
      workspace: { folder: '/wt', root: '/repo', worktree: null, base: null },
      phase: 'streaming' as const,
      origin: { kind: 'fresh' as const },
      startedAt: NOW.toISOString(),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities: { kind: 'pending' as const, request: { source: 'installed' as const } },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default' as const, model: null, effort: null },
      models: { kind: 'pending' as const },
      usage: null,
      backgroundTasks: [],
      stage: { agent: 'impl' as const, number: 303, kind: 'issue' as const, trigger: 'planApproved' as const },
      lastResult: { subtype: 'success', isError: false, text: 'QUESTIONS FOR HUMAN:\nwhich branch?\n\nNever mind, I figured it out myself.', at: NOW.toISOString() },
      operatorJoinedAt: null,
    }
    const items = needsYouItems(snapshotOf([]), NOW, [session])
    expect(items).toEqual([])
  })

  it('a live stage session with a pending question never also produces a stage-questions item', () => {
    const session = {
      sessionKey: 'hosted-1' as SessionKey,
      claudeSessionId: 's1',
      repoId: 'repo-a' as RepoId,
      workspace: { folder: '/wt', root: '/repo', worktree: null, base: null },
      phase: 'streaming' as const,
      origin: { kind: 'fresh' as const },
      startedAt: NOW.toISOString(),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [
        {
          permissionId: 'p1',
          toolName: 'AskUserQuestion',
          input: {},
          title: null,
          displayName: null,
          description: null,
          decisionReason: null,
          blockedPath: null,
          protectedPath: null,
          agentId: null,
          requestedAt: NOW.toISOString(),
          sessionGrant: null,
          interaction: { kind: 'question' as const, questions: [{ question: 'Which branch?', header: 'Branch', multiSelect: false, options: [] }] },
        },
      ],
      capabilities: { kind: 'pending' as const, request: { source: 'installed' as const } },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default' as const, model: null, effort: null },
      models: { kind: 'pending' as const },
      usage: null,
      backgroundTasks: [],
      stage: { agent: 'impl' as const, number: 300, kind: 'issue' as const, trigger: 'planApproved' as const },
      lastResult: { subtype: 'success', isError: false, text: 'QUESTIONS FOR HUMAN:\nwhich branch?', at: NOW.toISOString() },
      operatorJoinedAt: null,
    }
    const items = needsYouItems(snapshotOf([]), NOW, [session])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-question', number: 300 })
  })
})

describe('needsYouItems sort order', () => {
  it('mixed kinds come out strictly newest first', () => {
    const row = item({ number: 10, updatedAt: '2026-01-01T00:30:00.000Z', stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }] })
    const heldMatch = item({ number: 11, updatedAt: '2026-01-01T00:45:00.000Z', stage: 'trigger', stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }] })
    const repo = readyRepo({ items: [row, heldMatch] })
    const held = [{ number: 11, kind: 'pull-request' as const, trigger: 'readyForReview' as const, reason: 'conflicting' as const, contention: null, escalation: null }]
    const claims = [{ number: 12, kind: 'issue' as const, inFlight: 'inProgress' as const, class: 'stalled-confirmed' as const, retryKey: 'inProgress' as const }]
    const denial = { id: 'd1', repoId: 'repo-a' as RepoId, agent: 'impl' as const, number: 300, toolName: 'Bash', inputSummary: 'x', rule: 'Bash(x)', at: '2026-01-01T00:50:00.000Z' }
    const items = needsYouItems(snapshotOf([repo], { tick: [tickReport({ held, claims })], dispatch: [dispatchStatus({ denials: [denial] })] }), NOW)
    expect(items.map((i) => i.number)).toEqual([300, 11, 10, 12])
  })

  it('an item with a null updatedAt sorts after every timed item', () => {
    const timed = item({ number: 1, updatedAt: '2026-01-01T00:30:00.000Z' })
    const untimed = item({ number: 2, updatedAt: null })
    const repo = readyRepo({ items: [timed, untimed] })
    const items = needsYouItems(snapshotOf([repo]), NOW)
    expect(items.map((i) => i.number)).toEqual([1, 2])
  })

  it('equal timestamps fall back to repo name, then number descending', () => {
    const repoA = readyRepo({ repoId: 'repo-a' as RepoId, items: [item({ repoId: 'repo-a' as RepoId, number: 1, updatedAt: '2026-01-01T00:30:00.000Z' }), item({ repoId: 'repo-a' as RepoId, number: 3, updatedAt: '2026-01-01T00:30:00.000Z' })] })
    const items = needsYouItems(snapshotOf([repoA]), NOW)
    expect(items.map((i) => i.number)).toEqual([3, 1])
  })

  it('held and stalled items with no matched row keep at: null', () => {
    const held = [{ number: 1, kind: 'pull-request' as const, trigger: 'readyForReview' as const, reason: 'conflicting' as const, contention: null, escalation: null }]
    const claims = [{ number: 2, kind: 'issue' as const, inFlight: 'inProgress' as const, class: 'stalled-confirmed' as const, retryKey: 'inProgress' as const }]
    const items = needsYouItems(snapshotOf([], { tick: [tickReport({ held, claims })] }), NOW)
    expect(items.every((i) => i.at === null)).toBe(true)
  })
})

describe('needsYouCount / repoNeedsYou', () => {
  it("counts the full list and one repository's own slice", () => {
    const repoA = readyRepo({ repoId: 'repo-a' as RepoId, items: [item({ repoId: 'repo-a' as RepoId, number: 1 })] })
    const repoB = readyRepo({ repoId: 'repo-b' as RepoId, repo: 'o/b', items: [item({ repoId: 'repo-b' as RepoId, number: 2 })] })
    const items = needsYouItems(snapshotOf([repoA, repoB]), NOW)
    expect(needsYouCount(items)).toBe(2)
    expect(repoNeedsYou(items, 'repo-a' as RepoId)).toBe(1)
    expect(repoNeedsYou(items, 'repo-b' as RepoId)).toBe(1)
  })
})

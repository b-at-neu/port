import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { WriteOutcome } from '@/types/writes'
import type { ReconciledItem } from '@/types/state'
import type { TickReport } from '@/types/tick'
import { createAutoPlanner } from '@/main/dispatch/auto-plan'
import { dispatchContext, type DispatchContextOptions } from '../../../support/context'

const approve = vi.hoisted(() => vi.fn<(params: unknown) => Promise<WriteOutcome>>())
vi.mock('@/main/pipeline/operator/gate', () => ({ autoApprovePlan: (_ctx: unknown, params: unknown) => approve(params) }))

const REPO_ID = 'repo-a' as RepoId
const APPLIED: WriteOutcome = { kind: 'applied', argv: [] }
const REFUSED: WriteOutcome = { kind: 'verify-failed', message: 'no' }

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: 'o/a',
    kind: 'issue',
    number: 7,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/7',
    assignees: ['op'],
    stage: 'gate',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: true,
    status: 'gated',
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
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
    ...overrides,
  }
}

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [{ number: 7 }], labelRepairs: [], ...overrides }
}

function snapshotWith(tick: readonly TickReport[], items: readonly ReconciledItem[], readAt = '2026-01-01T00:00:00Z'): BoardSnapshot {
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op', items, freshness: { github: { at: readAt } } } as never],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: readAt },
      readAt,
    },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick,
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: readAt,
    dispatch: [],
  } as unknown as BoardSnapshot
}

async function planner(options: DispatchContextOptions = {}) {
  const ctx = await dispatchContext({ owner: 'app', ...options })
  return { ctx, planner: createAutoPlanner(ctx) }
}

const FIRST = snapshotWith([tickReport()], [item()], '2025-12-31T23:59:00Z')
const LATER = snapshotWith([tickReport()], [item()], '2026-01-01T00:01:00Z')

beforeEach(() => {
  approve.mockReset().mockResolvedValue(APPLIED)
})

describe('createAutoPlanner', () => {
  it('writes an auto-approval while this app owns the repository and the item is autoApprovable', async () => {
    const { planner: p } = await planner()
    await p.consider(FIRST)
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ item: { number: 7, assignees: ['op'] } }))
  })

  it.each([
    ['ownership is absent — a terminal cockpit may still start up', { owner: 'none' }],
    ['the ownership record cannot be read', { owner: 'unreadable' }],
    ['the repository is draining — the drain gate is deliberate', { runState: 'draining' }],
  ] as const)('writes nothing when %s', async (_name, options) => {
    const { planner: p } = await planner(options)
    await p.consider(FIRST)
    expect(approve).not.toHaveBeenCalled()
  })

  it('never re-fires for a snapshot the GitHub read has not caught up to yet, and retries once it moves past', async () => {
    const { planner: p } = await planner()
    await p.consider(FIRST)
    await p.consider(FIRST)
    expect(approve).toHaveBeenCalledTimes(1)
    await p.consider(LATER)
    expect(approve).toHaveBeenCalledTimes(2)
  })

  it('swallows a throw from the approval and records the item as refused', async () => {
    approve.mockRejectedValue(new Error('boom'))
    const { planner: p } = await planner()
    await expect(p.consider(FIRST)).resolves.toBeUndefined()
    expect([...p.refused(REPO_ID)]).toEqual([7])
  })

  it('requests one read for the repository after two applied approvals', async () => {
    const { ctx, planner: p } = await planner()
    await p.consider(snapshotWith([tickReport({ autoApprovals: [{ number: 7 }, { number: 8 }] })], [item(), item({ number: 8 })]))
    expect(ctx.watcher.refresh).toHaveBeenCalledTimes(1)
    expect(ctx.watcher.refresh).toHaveBeenCalledWith({ repoId: REPO_ID, source: 'github' })
  })

  it('requests no read for a no-op write', async () => {
    approve.mockResolvedValue({ kind: 'no-op' })
    const { ctx, planner: p } = await planner()
    await p.consider(FIRST)
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })

  describe('refused swaps', () => {
    it('records a non-applied outcome as refused and republishes once, not again while the set stays the same', async () => {
      approve.mockResolvedValue(REFUSED)
      const { ctx, planner: p } = await planner()
      await p.consider(FIRST)
      expect([...p.refused(REPO_ID)]).toEqual([7])
      expect(ctx.watcher.republish).toHaveBeenCalledTimes(1)
      await p.consider(LATER)
      expect(ctx.watcher.republish).toHaveBeenCalledTimes(1)
    })

    it('does not treat a no-op write as refused, and no signal fires', async () => {
      approve.mockResolvedValue({ kind: 'no-op' })
      const { ctx, planner: p } = await planner()
      await p.consider(FIRST)
      expect(p.refused(REPO_ID).size).toBe(0)
      expect(ctx.watcher.republish).not.toHaveBeenCalled()
    })

    it('clears a refusal once a later attempt lands', async () => {
      approve.mockResolvedValueOnce(REFUSED)
      const { planner: p } = await planner()
      await p.consider(FIRST)
      await p.consider(LATER)
      expect(p.refused(REPO_ID).size).toBe(0)
    })

    it('prunes a refusal whose label has moved on and signals the change', async () => {
      approve.mockResolvedValue(REFUSED)
      const { ctx, planner: p } = await planner()
      await p.consider(FIRST)
      await p.consider(snapshotWith([tickReport({ autoApprovals: [] })], [item()], '2026-01-01T00:01:00Z'))
      expect(p.refused(REPO_ID).size).toBe(0)
      expect(ctx.watcher.republish).toHaveBeenCalledTimes(2)
    })

    it('keeps a refusal across a blind report', async () => {
      approve.mockResolvedValue(REFUSED)
      const { planner: p } = await planner()
      await p.consider(FIRST)
      await p.consider(snapshotWith([tickReport({ autoApprovals: [], blind: { reason: 'github-unavailable' } as never })], [item()], '2026-01-01T00:01:00Z'))
      expect([...p.refused(REPO_ID)]).toEqual([7])
    })
  })
})

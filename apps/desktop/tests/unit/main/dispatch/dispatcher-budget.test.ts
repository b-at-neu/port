// Dispatcher-level budget-gate cases: reset-once/sweep-every-pass bookkeeping, the fail-closed
// budget-unavailable refusal, and per-candidate routing. Additive to dispatcher.test.ts, not a duplicate.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { TickReport } from '@/types/tick'
import type { EscalateToHumanParams, EscalateToHumanResult } from '@/types/actions'
import type { BudgetCheckResult, BudgetResetResult, BudgetSweepResult } from '@/types/dispatch'
import { pathOps } from '@/main/platform/paths'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { dispatchContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'
import { sessionSnapshot } from '../../../support/session-snapshot'
import { ticketOf } from '../../../support/tickets'

const gate = vi.hoisted(() => ({ reset: vi.fn(), sweep: vi.fn(), check: vi.fn() }))
const escalate = vi.hoisted(() => vi.fn<(params: EscalateToHumanParams) => Promise<EscalateToHumanResult>>())
vi.mock('@/main/dispatch/budget-gate', () => ({
  budgetReset: () => gate.reset() as unknown,
  budgetSweep: () => gate.sweep() as unknown,
  budgetCheck: () => gate.check() as unknown,
}))
vi.mock('@/main/pipeline/operator/escalate', () => ({ escalateToHuman: (_ctx: unknown, params: EscalateToHumanParams) => escalate(params) }))
vi.mock('@/main/pipeline/operator/stage', () => ({
  applyStageClaim: () => Promise.resolve({ kind: 'applied' }),
  applyStageTransition: () => Promise.resolve({ kind: 'applied' }),
}))

const REPO_ID = 'repo-a' as RepoId
const ENTRY = readyEntry({}, { commands: { worktrees: null, budget: 'node scripts/budget.mjs' } })
const IMPL_CANDIDATE = { number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }
const HOLD_LINE = "⏳ Couldn't read #52's cost ledger (unparseable table) — holding its dispatch one tick rather than dispatching blind."

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [], ...overrides }
}

function snapshotWith(tick: readonly TickReport[]): BoardSnapshot {
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op' } as never],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00Z' },
      readAt: '2026-01-01T00:00:00Z',
    },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick,
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
    dispatch: [],
    autoPlan: [],
  }
}

const withCandidate = (): BoardSnapshot => snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])

async function setup() {
  const ctx = await dispatchContext({
    owner: 'app',
    repositories: [ENTRY],
    items: [{ number: 52, title: 't', labels: ['plan approved'], assignees: ['op'] }],
    tickets: { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 52, stage: 'implement' })] },
    store: { snapshotOf: () => sessionSnapshot() },
    launcher: () => Promise.resolve({ ok: true, sessionKey: 'hosted-1' as never }),
  })
  return { ctx, dispatcher: createDispatcher(ctx) }
}

beforeEach(() => {
  gate.reset.mockReset().mockResolvedValue({ ok: true } satisfies BudgetResetResult)
  gate.sweep.mockReset().mockResolvedValue({ line: null, problem: null } satisfies BudgetSweepResult)
  gate.check.mockReset().mockResolvedValue({ ok: true, verdict: 'allow', line: 'allowed' } satisfies BudgetCheckResult)
  escalate.mockReset()
})

describe('createDispatcher — budget bookkeeping', () => {
  it('resets once, then sweeps on every pass, populating budget.line', async () => {
    gate.sweep.mockResolvedValue({ line: 'session 1 dispatch · 2m 00s agent wall-clock', problem: null })
    const { dispatcher } = await setup()
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(gate.reset).toHaveBeenCalledTimes(1)
    expect(gate.sweep).toHaveBeenCalledTimes(1)
    expect(dispatcher.status()[0]?.budget).toEqual({ line: 'session 1 dispatch · 2m 00s agent wall-clock', problem: null, notes: [], costUsd: null })

    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(gate.reset).toHaveBeenCalledTimes(1)
    expect(gate.sweep).toHaveBeenCalledTimes(2)
  })

  it('a reset failure reports budget-unavailable and dispatches nothing this pass', async () => {
    gate.reset.mockResolvedValue({ ok: false, kind: 'unavailable', message: "the budget ceiling can't be read (not on the default branch)." })
    const { dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'budget-unavailable', message: "the budget ceiling can't be read (not on the default branch)." })
  })

  it('sweeps even after ownership moves away from this app, while a session is still live', async () => {
    const { ctx, dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.owner).toBe('app')
    expect(gate.sweep).toHaveBeenCalledTimes(1)

    await ctx.stores.runStates.set([REPO_ID], 'paused', ctx.clock.now().toISOString())
    await ctx.fs.remove(pathOps.join('/repo', '.agents', 'cockpit.json'))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.owner).toBe('none')
    expect(gate.sweep).toHaveBeenCalledTimes(2)
  })
})

describe('createDispatcher — the budget gate itself', () => {
  it('allow launches the candidate — no notes', async () => {
    const { dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([])
    expect(dispatcher.status()[0]?.state.kind).toBe('active')
  })

  it('a first hold holds with a held note, and a second consecutive hold launches anyway', async () => {
    gate.check.mockResolvedValue({ ok: true, verdict: 'hold', line: HOLD_LINE })
    const { dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'held', number: 52, line: HOLD_LINE }])
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })

    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'held-dispatched', number: 52 }])
    expect(dispatcher.status()[0]?.state.kind).toBe('active')
  })

  it('exceeded escalates instead of launching, with an escalated note', async () => {
    const line = '⛔ #52 has consumed 2h 00m of agent wall-clock against a 120m ceiling — escalate instead of dispatching impl #52.'
    gate.check.mockResolvedValue({ ok: true, verdict: 'exceeded', line })
    escalate.mockResolvedValue({ labels: { kind: 'applied', argv: [] }, comment: { kind: 'applied', argv: [] } })
    const { dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(escalate).toHaveBeenCalledTimes(1)
    expect(escalate.mock.calls[0]?.[0]).toMatchObject({ trigger: 'planApproved', number: 52, body: expect.stringContaining(line) as unknown })
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'escalated', number: 52, needsHumanLabel: 'needs human', commentFailedMessage: null }])
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('escalation-failed carries the outcome, for the renderer to classify', async () => {
    const outcome = { kind: 'ownership-unreadable', path: '/repo/.agents/cockpit.json', message: 'bad' } as const
    gate.check.mockResolvedValue({ ok: true, verdict: 'exceeded', line: 'over budget' })
    escalate.mockResolvedValue({ labels: outcome, comment: null })
    const { dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs human', triggerLabel: 'plan approved', outcome }])
  })

  it('a failed gate check drops the candidate, and its note is kept when a later pass has nothing to gate', async () => {
    gate.check.mockResolvedValue({ ok: false, kind: 'failed', message: 'FAIL  something broke' })
    const { dispatcher } = await setup()
    await dispatcher.consider(withCandidate())
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' }])
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })

    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' }])
  })
})

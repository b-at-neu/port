import { beforeEach, describe, expect, it, vi } from 'vitest'
import { budgetLiveSets, budgetRoute, escalateOverBudget, escalationBody, sumCostUsd } from '@/main/dispatch/budget'
import type { EscalateToHumanParams, EscalateToHumanResult, ReadyEntry } from '@/types/actions'
import { createTestContext } from '../../../support/context'
import type { BudgetNote, StageRecord } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { TickActionable } from '@/types/tick'
import { resolveDisplayVocabulary } from '@/utils/labels/display'

const escalate = vi.hoisted(() => vi.fn<(params: EscalateToHumanParams) => Promise<EscalateToHumanResult>>())
vi.mock('@/main/pipeline/operator/escalate', () => ({ escalateToHuman: (_ctx: unknown, params: EscalateToHumanParams) => escalate(params) }))

function record(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    runId: 'run-1',
    sessionKey: 'hosted-1' as SessionKey,
    agent: 'impl',
    stage: 'implement',
    number: 52,
    kind: 'issue',
    state: 'started',
    at: '2026-09-05T14:00:00.000Z',
    endedAt: null,
    detail: null,
    outcome: null,
    claudeSessionId: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

describe('budgetRoute', () => {
  it('allow dispatches and resets the hold streak', () => {
    expect(budgetRoute('allow', 3)).toEqual({ action: 'dispatch', holds: 0 })
  })

  it('exceeded escalates and resets the hold streak', () => {
    expect(budgetRoute('exceeded', 0)).toEqual({ action: 'escalate', holds: 0 })
  })

  it('a first hold holds this pass', () => {
    expect(budgetRoute('hold', 0)).toEqual({ action: 'hold', holds: 1 })
  })

  it('a second consecutive hold dispatches anyway and resets the streak', () => {
    expect(budgetRoute('hold', 1)).toEqual({ action: 'dispatch', holds: 0 })
  })
})

describe('budgetLiveSets', () => {
  it('a started record is live', () => {
    const { live } = budgetLiveSets([record({ state: 'started' })])
    expect(live).toContain('impl #52')
  })

  it('an ended record whose outcome is completed, not covered by a live record, is completed', () => {
    const { completed, live } = budgetLiveSets([record({ state: 'ended', outcome: { kind: 'completed', detail: null, costUsd: 1, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: null } })])
    expect(completed).toEqual(['impl #52'])
    expect(live).not.toContain('impl #52')
  })

  it('a failed record is in neither set', () => {
    const { completed, live } = budgetLiveSets([record({ state: 'failed', detail: 'boom' })])
    expect(live).not.toContain('impl #52')
    expect(completed).not.toContain('impl #52')
  })

  it('an ended record that crashed or errored closes as lost, not completed', () => {
    const { completed, live } = budgetLiveSets([record({ state: 'ended', outcome: { kind: 'error', detail: 'boom', costUsd: 1, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null } })])
    expect(live).not.toContain('impl #52')
    expect(completed).not.toContain('impl #52')
  })

  it('a live record for a description wins over an ended one for the same description', () => {
    const records = [
      record({ sessionKey: 's1' as SessionKey, state: 'ended', outcome: { kind: 'completed', detail: null, costUsd: 1, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: null } }),
      record({ sessionKey: 's2' as SessionKey, state: 'started' }),
    ]
    const { live, completed } = budgetLiveSets(records)
    expect(live).toContain('impl #52')
    expect(completed).not.toContain('impl #52')
  })
})

describe('sumCostUsd', () => {
  it('sums every record carrying a known cost', () => {
    const records = [
      record({ outcome: { kind: 'completed', detail: null, costUsd: 1.5, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: null } }),
      record({ sessionKey: 's2' as SessionKey, outcome: { kind: 'error', detail: null, costUsd: 0.5, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null } }),
    ]
    expect(sumCostUsd(records)).toBe(2)
  })

  it('returns null when no record carries a known cost', () => {
    expect(sumCostUsd([record({ outcome: null })])).toBeNull()
  })
})

describe('escalateOverBudget', () => {
  const entry = { config: { displayVocabulary: resolveDisplayVocabulary({}) } } as unknown as ReadyEntry
  const candidate = (overrides: Partial<TickActionable> = {}): TickActionable => ({ number: 52, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: false, cycle: null, ...overrides })

  beforeEach(() => {
    escalate.mockReset().mockResolvedValue({ labels: { kind: 'applied', argv: [] }, comment: null })
  })

  it('records an escalated note when the swap applies, passing the budget body and action', async () => {
    const ctx = createTestContext()
    const notes: BudgetNote[] = []
    await escalateOverBudget(ctx, { entry, candidate: candidate(), line: 'over', notes, viewer: 'op', item: undefined })
    expect(escalate.mock.calls[0]?.[0]).toMatchObject({ kind: 'issue', number: 52, viewer: 'op', action: 'budget-escalate', auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp, body: escalationBody('over', null) })
    expect(notes).toEqual([{ kind: 'escalated', number: 52, needsHumanLabel: 'needs you', commentFailedMessage: null }])
  })

  it('records an escalation-failed note naming the label when the write is refused', async () => {
    const notes: BudgetNote[] = []
    const outcome = { kind: 'item-unavailable' } as const
    escalate.mockResolvedValue({ labels: outcome, comment: null })
    await escalateOverBudget(createTestContext(), { entry, candidate: candidate(), line: 'over', notes, viewer: 'op', item: undefined })
    expect(notes).toEqual([{ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs you', outcome }])
  })

  it('carries the head sha on a pull request, and skips the comment body when that escalation already repeats', async () => {
    const ctx = createTestContext()
    const review = candidate({ kind: 'pull-request', stage: 'review', mode: 'review', agent: 'review' })
    await escalateOverBudget(ctx, { entry, candidate: review, line: 'over', notes: [], viewer: 'op', item: { headRefOid: 'abc123', comments: [] } })
    expect(escalate.mock.calls[0]?.[0].body).toBe(escalationBody('over', 'abc123'))

    const repeated = [{ body: escalationBody('over', 'abc123'), createdAt: '2026-01-01T00:00:00Z', author: 'op' }]
    await escalateOverBudget(ctx, { entry, candidate: review, line: 'over', notes: [], viewer: 'op', item: { headRefOid: 'abc123', comments: repeated } })
    expect(escalate.mock.calls[1]?.[0].body).toBeNull()
  })
})

describe('escalationBody', () => {
  it('carries the gate line verbatim and names the app as the stopping point', () => {
    const body = escalationBody('⛔ #52 has consumed 2h 00m of agent wall-clock against a 120m ceiling — escalate instead of dispatching impl #52.', null)
    expect(body).toContain('## Pipeline Escalation')
    expect(body).toContain('⛔ #52 has consumed 2h 00m')
    expect(body).toContain("This app's dispatcher stopped here")
    expect(body).not.toContain('port:escalation')
  })

  it('ends a pull request body with the budget marker for its head', () => {
    const body = escalationBody('⛔ over budget', 'abc123')
    expect(body.endsWith('\n<!-- port:escalation budget abc123 -->')).toBe(true)
  })
})

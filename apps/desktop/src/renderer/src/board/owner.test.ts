// Covers the line's pure copy function — `buildOwnerLine` itself needs a
// DOM, which this workspace's vitest config does not provide (`environment:
// 'node'`, no jsdom/happy-dom installed), the same gap every other DOM
// builder under `renderer/src/board/` already has (see `tick.test.ts`'s own
// header). `observationClause`/`observationTitle` (#292) are exported
// specifically so the owner-line's observation clause and hover title — both
// otherwise reachable only from `buildOwnerLine`'s DOM — have a direct,
// DOM-free test surface.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { ObservationRecord, RepoDispatchStatus } from '../../../shared/dispatch/types'
import { noteCopy, observationClause, observationTitle, ownerLineCopy } from './owner'

const WRITE_FAILED = { kind: 'write-failed' as const, classification: 'unknown' as const, stderr: 'boom', reread: null }

const REPO_ID = 'repo-a' as RepoId

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, draining: false, claudeSessionId: null, claimedAt: null, budget: null, observed: [], ...overrides }
}

function record(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return { kind: 'liveness-reset', number: 1, itemKind: 'issue', at: '2026-01-01T14:00:00Z', outcome: 'written', scope: null, comment: 'none', ...overrides }
}

describe('ownerLineCopy', () => {
  it('nobody — the unreadable-claim line', () => {
    expect(ownerLineCopy(status({ owner: 'nobody' }))).toContain("can't be read")
  })

  it('cockpit — the standard-pipeline line', () => {
    expect(ownerLineCopy(status({ owner: 'cockpit' }))).toContain('your terminal cockpit dispatches here')
  })

  it('app, idle, never claimed — no "claimed" clause', () => {
    expect(ownerLineCopy(status())).toBe('▶ Dispatch: this app · nothing to dispatch.')
  })

  it('app, idle, claimed — the claimed-time clause', () => {
    const line = ownerLineCopy(status({ claimedAt: '2026-01-01T14:02:00Z' }))
    expect(line).toContain('claimed')
    expect(line).toContain('nothing to dispatch')
  })

  it('app, active — names every sent/started record and the newest time', () => {
    const line = ownerLineCopy(
      status({
        state: {
          kind: 'active',
          recent: [
            { agent: 'plan', number: 105, kind: 'issue', state: 'started', at: '2026-01-01T14:00:00Z' },
            { agent: 'impl', number: 52, kind: 'issue', state: 'sent', at: '2026-01-01T14:07:00Z' },
          ],
        },
      }),
    )
    expect(line).toContain('plan #105')
    expect(line).toContain('impl #52')
  })

  it('app, active — a not-started record is never named', () => {
    const line = ownerLineCopy(status({ state: { kind: 'active', recent: [{ agent: 'impl', number: 52, kind: 'issue', state: 'not-started', at: '2026-01-01T14:07:00Z' }] } }))
    expect(line).toBe('▶ Dispatch: this app · nothing to dispatch.')
  })

  it('budget-unavailable renders the pre-assembled message verbatim', () => {
    const message = "commands.budget can't run (could not be parsed as a plain command prefix). Fix it in .claude/port.config.json, or release dispatch to hand it back to the cockpit."
    expect(ownerLineCopy(status({ state: { kind: 'budget-unavailable', message } }))).toBe(`⏸ Dispatch: this app, but not dispatching — ${message}`)
  })

  it('the budget clause is appended for every owner, including cockpit and nobody', () => {
    const budget = { line: 'session 2 dispatches · 41m 12s agent wall-clock', problem: null, notes: [] }
    expect(ownerLineCopy(status({ budget }))).toContain('Budget: session 2 dispatches')
    expect(ownerLineCopy(status({ owner: 'cockpit', budget }))).toContain('Budget: session 2 dispatches')
    expect(ownerLineCopy(status({ owner: 'nobody', budget }))).toContain('Budget: session 2 dispatches')
  })

  it('no budget clause when the status carries none', () => {
    expect(ownerLineCopy(status())).not.toContain('Budget:')
  })

  it('dispatcher-failed — at-capacity names the limit', () => {
    expect(ownerLineCopy(status({ state: { kind: 'dispatcher-failed', reason: 'at-capacity', limit: 4 } }))).toContain('4 hosted sessions')
  })

  it('dispatcher-failed — plugin', () => {
    expect(ownerLineCopy(status({ state: { kind: 'dispatcher-failed', reason: 'plugin' } }))).toContain("plugin didn't load")
  })

  it('agents-missing names the dropped agent', () => {
    expect(ownerLineCopy(status({ state: { kind: 'agents-missing', agent: 'impl' } }))).toContain('port:impl-agent')
  })
})

describe('noteCopy', () => {
  it('held — the script line verbatim', () => {
    const line = "⏳ Couldn't read #158's cost ledger (unparseable table) — holding its dispatch one tick rather than dispatching blind."
    expect(noteCopy({ kind: 'held', number: 158, line })).toBe(line)
  })

  it('held-dispatched', () => {
    expect(noteCopy({ kind: 'held-dispatched', number: 158 })).toContain("Still can't read #158's cost ledger after two polls")
  })

  it('escalated — comment applied', () => {
    expect(noteCopy({ kind: 'escalated', number: 52, needsHumanLabel: 'needs human', commentFailedMessage: null })).toBe('⛔ #52 is over its budget ceiling — moved it to needs human and commented why.')
  })

  it('escalated — comment failed', () => {
    const line = noteCopy({ kind: 'escalated', number: 52, needsHumanLabel: 'needs human', commentFailedMessage: 'boom' })
    expect(line).toContain("didn't post (boom)")
  })

  it('escalation-failed — unclaimed-scope names the trigger and the claim', () => {
    const outcome = { kind: 'unclaimed-scope' as const, scope: 'plan-gate' as const, claimPath: '/x', keys: ['planApproved' as const] }
    const line = noteCopy({ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs human', triggerLabel: 'plan approved', outcome })
    expect(line).toContain('removing plan approved needs the plan gate claim')
    expect(line).toContain('needs human')
  })

  it('escalation-failed — any other outcome falls back to writeOutcomeCopy', () => {
    const line = noteCopy({ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs human', triggerLabel: 'plan approved', outcome: WRITE_FAILED })
    expect(line).toContain('failed:')
    expect(line).toContain('GitHub refused the write.')
  })

  it('gate-failed', () => {
    expect(noteCopy({ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' })).toContain('FAIL  something broke')
  })
})

describe('observationClause', () => {
  it('is empty when nothing has been observed yet', () => {
    expect(observationClause([])).toBe('')
  })

  it('renders only the newest record, even with several observed', () => {
    const first = record({ kind: 'liveness-reset', number: 1, outcome: 'written' })
    const second = record({ kind: 'cycle-cap', number: 2, outcome: 'already' })
    const clause = observationClause([first, second])
    expect(clause).toContain('#2 was already escalated.')
    expect(clause).not.toContain('#1')
  })

  it('written — per-kind phrasing, covering every TickObservationKind', () => {
    expect(observationClause([record({ kind: 'liveness-reset', number: 10 })])).toContain('reset #10')
    expect(observationClause([record({ kind: 'cycle-cap', number: 11 })])).toContain('escalated #11 to needs human')
    expect(observationClause([record({ kind: 'cycle-cap', number: 11 })])).toContain('review cycle cap was reached')
    expect(observationClause([record({ kind: 'zero-diff', number: 12 })])).toContain('the latest review already covers the current head')
    expect(observationClause([record({ kind: 'refresh', number: 13 })])).toContain('refreshing #13')
    expect(observationClause([record({ kind: 'refresh-stuck', number: 14 })])).toContain('still conflicting after a refresh')
    expect(observationClause([record({ kind: 'withdraw-approval', number: 15 })])).toContain('withdrew approval on #15')
    expect(observationClause([record({ kind: 'refresh-deferred', number: 16 })])).toContain('updated #16')
  })

  it('already / moved / failed outcomes', () => {
    expect(observationClause([record({ kind: 'cycle-cap', number: 20, outcome: 'already' })])).toContain('#20 was already escalated.')
    expect(observationClause([record({ kind: 'cycle-cap', number: 21, outcome: 'moved' })])).toContain('#21 moved before this app could escalate it — nothing was written.')
    expect(observationClause([record({ kind: 'cycle-cap', number: 22, outcome: 'failed' })])).toContain('GitHub refused the write.')
  })

  it('written with a failed comment uses the commentFailed phrasing instead of the written one', () => {
    const clause = observationClause([record({ kind: 'liveness-reset', number: 23, outcome: 'written', comment: 'failed' })])
    expect(clause).toContain("reset #23, but its explanation comment didn't post.")
    expect(clause).not.toContain('no agent was attached')
  })

  it('refused — plan-gate scope on liveness-reset gets the dedicated plan-gate copy', () => {
    const clause = observationClause([record({ kind: 'liveness-reset', number: 24, outcome: 'refused', scope: 'plan-gate' })])
    expect(clause).toContain('moving it back needs the plan gate too')
  })

  it('refused — every other kind has no plan-gate copy, so a plan-gate scope still falls back to the dispatch-released line', () => {
    const clause = observationClause([record({ kind: 'cycle-cap', number: 25, outcome: 'refused', scope: 'plan-gate' })])
    expect(clause).toContain("didn't escalate #25 — dispatch was released mid-pass.")
  })

  it('refused — a non-plan-gate scope always uses the dispatch-released copy', () => {
    expect(observationClause([record({ kind: 'liveness-reset', number: 26, outcome: 'refused', scope: 'dispatch' })])).toContain("didn't reset #26 — dispatch was released mid-pass.")
    expect(observationClause([record({ kind: 'liveness-reset', number: 27, outcome: 'refused', scope: null })])).toContain("didn't reset #27 — dispatch was released mid-pass.")
  })
})

describe('observationTitle', () => {
  it('is null when nothing has been observed yet', () => {
    expect(observationTitle([])).toBeNull()
  })

  it('lists every record, newest first', () => {
    const first = record({ kind: 'liveness-reset', number: 1, outcome: 'written', at: '2026-01-01T14:00:00Z' })
    const second = record({ kind: 'cycle-cap', number: 2, outcome: 'already', at: '2026-01-01T15:00:00Z' })
    const title = observationTitle([first, second])
    const lines = title?.split('\n') ?? []
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('#2 cycle-cap — already')
    expect(lines[1]).toContain('#1 liveness-reset — written')
  })
})

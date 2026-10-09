// Covers the owner line's pure copy, including `controlFor`/`budgetNoteLines`
// (#319) — both now exported directly for `pipeline-status.tsx` to consume,
// in place of the deleted `buildOwnerLine`'s own DOM.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { ObservationRecord, RepoDispatchStatus } from '../../../shared/dispatch/types'
import { budgetNoteLines, controlFor, noteCopy, observationClause, observationTitle, ownerLineCopy, runStateSuffix } from './owner'

const WRITE_FAILED = { kind: 'write-failed' as const, classification: 'unknown' as const, stderr: 'boom', reread: null }

const REPO_ID = 'repo-a' as RepoId

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], ...overrides }
}

function record(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return { kind: 'liveness-reset', number: 1, itemKind: 'issue', at: '2026-01-01T14:00:00Z', outcome: 'written', comment: 'none', ...overrides }
}

describe('ownerLineCopy', () => {
  it('unreadable — names the reason and that neither side runs it', () => {
    const line = ownerLineCopy(status({ owner: 'unreadable', unreadableMessage: 'invalid JSON' }))
    expect(line).toContain("can't be read")
    expect(line).toContain('invalid JSON')
    expect(line).toContain('Neither this app nor a terminal cockpit')
  })

  it('terminal — names since and that this app writes nothing here', () => {
    const line = ownerLineCopy(status({ owner: 'terminal', ownedSince: '2026-01-01T14:02:00Z' }))
    expect(line).toContain('your terminal cockpit runs this repo')
    expect(line).toContain("won't dispatch, answer gates, or write labels")
  })

  it('none — idle here, Run starts it', () => {
    expect(ownerLineCopy(status({ owner: 'none' }))).toContain('idle here')
  })

  it('app, idle, never owned — no "since" clause', () => {
    expect(ownerLineCopy(status())).toBe('▶ Dispatch: this app · nothing to dispatch.')
  })

  it('app, idle, owned — the since-time clause', () => {
    const line = ownerLineCopy(status({ ownedSince: '2026-01-01T14:02:00Z' }))
    expect(line).toContain('since')
    expect(line).toContain('nothing to dispatch')
  })

  it('app, active — names every started record and the newest time', () => {
    const line = ownerLineCopy(
      status({
        state: {
          kind: 'active',
          recent: [
            { agent: 'plan', number: 105, kind: 'issue', state: 'started', at: '2026-01-01T14:00:00Z', detail: null },
            { agent: 'impl', number: 52, kind: 'issue', state: 'started', at: '2026-01-01T14:07:00Z', detail: null },
          ],
        },
      }),
    )
    expect(line).toContain('plan #105')
    expect(line).toContain('impl #52')
  })

  it('app, active — a failed record is never named as started, but appends its own clause', () => {
    const line = ownerLineCopy(status({ state: { kind: 'active', recent: [{ agent: 'impl', number: 52, kind: 'issue', state: 'failed', at: '2026-01-01T14:07:00Z', detail: 'boom' }] } }))
    expect(line).toContain('nothing to dispatch')
    expect(line).toContain("couldn't start impl #52 (boom)")
  })

  it('budget-unavailable renders the pre-assembled message verbatim', () => {
    const message = "commands.budget can't run (could not be parsed as a plain command prefix). Fix it in .claude/port.config.json, or release dispatch to hand it back to the cockpit."
    expect(ownerLineCopy(status({ state: { kind: 'budget-unavailable', message } }))).toBe(`⏸ Dispatch: this app, but not dispatching — ${message}`)
  })

  it('the budget clause is appended for every owner, including terminal and unreadable', () => {
    const budget = { line: 'session 2 dispatches · 41m 12s agent wall-clock', problem: null, notes: [] }
    expect(ownerLineCopy(status({ budget }))).toContain('Budget: session 2 dispatches')
    expect(ownerLineCopy(status({ owner: 'terminal', budget }))).toContain('Budget: session 2 dispatches')
    expect(ownerLineCopy(status({ owner: 'unreadable', budget }))).toContain('Budget: session 2 dispatches')
  })

  it('no budget clause when the status carries none', () => {
    expect(ownerLineCopy(status())).not.toContain('Budget:')
  })

  it('no-launcher holds visibly', () => {
    expect(ownerLineCopy(status({ state: { kind: 'no-launcher' } }))).toContain("can't start stage sessions yet")
  })

  it('at-capacity names the limit and the waiting count, singular', () => {
    expect(ownerLineCopy(status({ state: { kind: 'at-capacity', limit: 4, waiting: 1 } }))).toBe(
      '⏸ Dispatch: this app · 1 waiting for a session slot — all 4 are in use. Close a session or raise the limit; they start on the next poll.',
    )
  })

  it('at-capacity, plural waiting', () => {
    expect(ownerLineCopy(status({ state: { kind: 'at-capacity', limit: 4, waiting: 2 } }))).toContain('2 waiting')
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

  it('escalation-failed — terminal-owned names the trigger and the terminal cockpit', () => {
    const outcome = { kind: 'terminal-owned' as const, since: '2026-01-01T14:02:00Z' }
    const line = noteCopy({ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs human', triggerLabel: 'plan approved', outcome })
    expect(line).toContain('removing plan approved was refused')
    expect(line).toContain('owned by your terminal cockpit')
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

  it('refused — every kind reads as the terminal cockpit taking this repo mid-pass', () => {
    expect(observationClause([record({ kind: 'liveness-reset', number: 26, outcome: 'refused' })])).toContain("didn't reset #26 — your terminal cockpit took this repo mid-pass.")
    expect(observationClause([record({ kind: 'cycle-cap', number: 27, outcome: 'refused' })])).toContain("didn't escalate #27 — your terminal cockpit took this repo mid-pass.")
  })
})

describe('controlFor', () => {
  it('app, none, and unreadable get no control at all', () => {
    expect(controlFor(status({ owner: 'app' }))).toBeNull()
    expect(controlFor(status({ owner: 'none' }))).toBeNull()
    expect(controlFor(status({ owner: 'unreadable' }))).toBeNull()
  })

  it('terminal offers Take over…', () => {
    expect(controlFor(status({ owner: 'terminal' }))?.label).toBe('Take over…')
  })
})

describe('budgetNoteLines', () => {
  it('empty when this app does not own dispatch, even with a budget present', () => {
    const budget = { line: null, problem: null, notes: [{ kind: 'held' as const, number: 1, line: 'held' }] }
    expect(budgetNoteLines(status({ owner: 'terminal', budget }))).toEqual([])
  })

  it('empty when there is no budget at all', () => {
    expect(budgetNoteLines(status({ budget: null }))).toEqual([])
  })

  it('one line per note, plus the sweep problem line when present', () => {
    const budget = { line: null, problem: 'timed out', notes: [{ kind: 'held' as const, number: 1, line: 'held note' }] }
    const lines = budgetNoteLines(status({ budget }))
    expect(lines).toEqual(['held note', '⚠ Budget sweep failed (timed out) — finished dispatches stay open and keep counting until a sweep succeeds.'])
  })
})

describe('runStateSuffix', () => {
  it('draining and paused get their own suffix, dispatching gets none', () => {
    expect(runStateSuffix('draining')).toBe(' · draining')
    expect(runStateSuffix('paused')).toBe(' · paused')
    expect(runStateSuffix('dispatching')).toBe('')
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

import { describe, expect, it } from 'vitest'
import { actionResultCopy } from '@/renderer/board/copy'
import { decisionResultCopy } from '@/renderer/decision/copy'
import { resultCopy } from '@/renderer/gate/copy'
import { mirrorReason } from '@/renderer/lib/mirror-reason'
import type { ActionPlan } from '@/types/actions'
import type { WriteOutcome } from '@/types/writes'

const MIRROR: WriteOutcome = { kind: 'write-failed', classification: 'network', stderr: 'dial tcp: offline\nretry later', reread: null }
const MIRROR_FAILED: WriteOutcome = { kind: 'mirror-failed', mirror: MIRROR }
const UNSAVED: WriteOutcome = { kind: 'state-unsaved', message: 'disk full' }
const PLAN = { add: ['planApproved'], remove: ['planReview'], addAssignees: [], removeAssignees: [], expect: { present: [], absent: [], assignees: { kind: 'any' } }, action: 'gate' } as unknown as ActionPlan

describe('mirrorReason', () => {
  it.each([
    [MIRROR, 'dial tcp: offline'],
    [{ kind: 'verify-failed', message: 'offline' }, 'offline'],
    [{ kind: 'item-unavailable' }, 'the item is no longer available'],
    [{ kind: 'terminal-owned', since: 't' }, 'a terminal cockpit owns this repository'],
    [{ kind: 'unresolvable-label', keys: ['marker', 'ready'] }, 'no label is configured for marker, ready'],
    [MIRROR_FAILED, 'dial tcp: offline'],
  ] as const)('explains %j', (outcome, reason) => {
    expect(mirrorReason(outcome)).toBe(reason)
  })
})

describe('the board row', () => {
  const copy = (result: WriteOutcome, plan: ActionPlan | null = PLAN) => actionResultCopy({ action: 'gate', number: 12, plan, currentStageName: null, result: { ok: true, outcome: result }, now: new Date('2026-01-01T00:00:00Z') })

  it('says nothing changed, why, and to try again, when the state could not be saved', () => {
    expect(copy(UNSAVED)).toBe("port couldn't save its pipeline state for #12, so nothing changed — disk full. Try again.")
  })

  it('names the phase it moved to, and the reason the label did not follow', () => {
    expect(copy(MIRROR_FAILED)).toBe("#12 moved to Plan approved, but its GitHub label couldn't be updated — dial tcp: offline. The next write will correct it.")
  })

  it('falls back to a plain phrase when the write adds no stage', () => {
    expect(copy(MIRROR_FAILED, null)).toContain('#12 moved to its new state')
  })
})

describe('the plan gate and decision dialogs', () => {
  const gate = (labels: WriteOutcome) => resultCopy({ number: 12, decision: 'approve', response: { kind: 'answered', comment: null, labels }, sessionRequired: false, ownership: { kind: 'app', since: 't' } })
  const decision = (labels: WriteOutcome) => decisionResultCopy({ number: 12, decision: 'unblock', route: 'implementation', picks: null, response: { ok: true, comment: null, labels } })

  it('reports a gate answer that moved the state but not the label as answered, with the reason', () => {
    expect(gate(MIRROR_FAILED)).toMatchObject({ tone: 'success', line: 'Plan answered for #12.', note: "The GitHub label couldn't be updated — dial tcp: offline." })
  })

  it('reports a gate answer that could not be saved as an error, with Dismiss', () => {
    expect(gate(UNSAVED)).toMatchObject({ tone: 'error', line: "Couldn't save the decision for #12.", note: 'disk full Nothing was written.', actions: ['dismiss'] })
  })

  it('words the decision dialog the same way', () => {
    expect(decision(MIRROR_FAILED)).toMatchObject({ tone: 'success', line: 'Decision recorded for #12.' })
    expect(decision(UNSAVED)).toMatchObject({ tone: 'error', line: "Couldn't save the decision for #12." })
  })
})

import { describe, expect, it } from 'vitest'
import type { GateAnswerResponse } from '../../../shared/gate/types'
import type { ClaimRead } from '../../../shared/writes/types'
import { autoPlanNoteCopy, claimLineCopy, isClaimHeldForPlanGate, primaryApproveLabel, refusedVerdictCopy, resultCopy, sessionRequiredCopy } from './copy'

describe('claimLineCopy', () => {
  it('renders the absent line verbatim from docs/COORDINATION.md', () => {
    const claim: ClaimRead = { state: 'absent', path: 'p', readAt: 'r' }
    expect(claimLineCopy(claim)).toEqual({ line: "The plan gate isn't claimed here.", note: 'The cockpit is still answering it in your terminal.', action: 'take' })
  })

  it('renders the held line with the owner and claimedAt', () => {
    const claim: ClaimRead = { state: 'held', owner: 'port-desktop', scopes: ['plan-gate'], unknownScopes: [], claimedAt: '2026-09-05T14:02:11Z', path: 'p', readAt: 'r' }
    const copy = claimLineCopy(claim)
    expect(copy.line).toBe('Plan gate claimed by `port-desktop` since 2026-09-05T14:02:11Z.')
    expect(copy.action).toBe('release')
  })

  it('names an unknown scope alongside the held line', () => {
    const claim: ClaimRead = { state: 'held', owner: 'port-desktop', scopes: ['plan-gate'], unknownScopes: ['future-scope'], claimedAt: 't', path: 'p', readAt: 'r' }
    expect(claimLineCopy(claim).note).toContain('future-scope')
  })

  it('renders the unreadable line with the reason', () => {
    const claim: ClaimRead = { state: 'unreadable', message: 'invalid JSON', path: '.agents/gate-claim.json', readAt: 'r' }
    const copy = claimLineCopy(claim)
    expect(copy.line).toContain('.agents/gate-claim.json')
    expect(copy.line).toContain('invalid JSON')
    expect(copy.action).toBe('overwrite')
  })
})

describe('isClaimHeldForPlanGate', () => {
  it('is true only when held and scopes include plan-gate', () => {
    expect(isClaimHeldForPlanGate({ state: 'absent', path: 'p', readAt: 'r' })).toBe(false)
    expect(isClaimHeldForPlanGate({ state: 'held', owner: 'x', scopes: [], unknownScopes: [], claimedAt: 't', path: 'p', readAt: 'r' })).toBe(false)
    expect(isClaimHeldForPlanGate({ state: 'held', owner: 'x', scopes: ['plan-gate'], unknownScopes: [], claimedAt: 't', path: 'p', readAt: 'r' })).toBe(true)
  })
})

describe('sessionRequiredCopy', () => {
  it('names /port:implement and that no agent picks it up', () => {
    const copy = sessionRequiredCopy(148, 'E3 · Plan review gate', "touches `.claude/**`")
    expect(copy.note).toContain('/port:implement 148')
    expect(copy.note).toContain('no agent will ever pick it up')
    expect(copy.launchLine).toBe('claude -n "#148: E3 · Plan review gate"')
  })
})

describe('primaryApproveLabel', () => {
  it('changes only for session-required', () => {
    expect(primaryApproveLabel(false)).toBe('Approve')
    expect(primaryApproveLabel(true)).toBe("Approve — I'll run it myself")
  })
})

describe('autoPlanNoteCopy', () => {
  it('is a stable note', () => {
    expect(autoPlanNoteCopy()).toContain('auto-approve')
  })
})

describe('refusedVerdictCopy', () => {
  it.each([
    ['not-found' as const, "#148 doesn't exist."],
    ['not-an-issue' as const, '#148 is a pull request now.'],
  ])('renders a line for %s', (kind, expected) => {
    expect(refusedVerdictCopy(148, { kind }).line).toBe(expected)
  })

  it('names the observed labels for not-at-plan-review', () => {
    const copy = refusedVerdictCopy(148, { kind: 'not-at-plan-review', observed: ['plan approved'] })
    expect(copy.note).toContain('plan approved')
  })
})

describe('resultCopy', () => {
  it('approve + applied, not session-required', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'applied', argv: [] } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe('#148 approved.')
    expect(copy.note).toContain('dispatches implementation')
  })

  it('approve + applied, session-required announces instead of dispatching', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'applied', argv: [] } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: true })
    expect(copy.note).toContain('/port:implement')
  })

  it('request-changes with both applied', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: { kind: 'applied', argv: [] }, labels: { kind: 'applied', argv: [] } }
    const copy = resultCopy({ number: 148, decision: 'request-changes', response, sessionRequired: false })
    expect(copy.line).toBe('#148 moved to `plan changes requested`.')
  })

  it('comment applied but labels aborted — presents exactly that, with retry and show-state', () => {
    const response: GateAnswerResponse = {
      kind: 'answered',
      comment: { kind: 'applied', argv: [] },
      labels: { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: ['plan review'], observed: ['plan approved'], readAt: 't' } },
    }
    const copy = resultCopy({ number: 148, decision: 'request-changes', response, sessionRequired: false })
    expect(copy.line).toBe("Your feedback is posted on #148, but the label didn't move.")
    expect(copy.actions).toEqual(['retry-label', 'show-state'])
  })

  it('comment-failed aborts before any label, offering try-again', () => {
    const response: GateAnswerResponse = { kind: 'comment-failed', comment: { kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null } }
    const copy = resultCopy({ number: 148, decision: 'request-changes', response, sessionRequired: false })
    expect(copy.line).toBe('Your feedback wasn\'t posted.')
    expect(copy.actions).toEqual(['try-again'])
  })

  it('labels precondition-failed alone (approve path)', () => {
    const response: GateAnswerResponse = {
      kind: 'answered',
      comment: null,
      labels: { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: ['plan review'], observed: ['plan approved'], readAt: 't' } },
    }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe('#148 moved while you were deciding.')
    expect(copy.actions).toEqual(['show-state'])
  })

  it('labels no-op', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'no-op' } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe('#148 already carries that label.')
  })

  it('labels unclaimed-scope offers take-claim', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'unclaimed-scope', scope: 'plan-gate', claimPath: 'p', keys: ['planApproved'] } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.actions).toEqual(['take-claim'])
  })

  it('labels claim-unreadable offers take-claim', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'claim-unreadable', scope: 'plan-gate', claimPath: 'p', message: 'bad json' } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.actions).toEqual(['take-claim'])
  })

  it('labels write-failed', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'write-failed', classification: 'network', stderr: 'gh: 500', reread: null } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe('GitHub refused the write.')
    expect(copy.note).toContain('gh: 500')
  })

  it('labels verify-failed', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'verify-failed', message: 'timeout' } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.note).toContain('timeout')
  })

  it('labels item-unavailable', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'item-unavailable' } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.note).toContain('no longer available')
  })

  it('labels unresolvable-label', () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'unresolvable-label', keys: ['planApproved'] } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.note).toContain('planApproved')
  })

  it('refused: not-found', () => {
    const response: GateAnswerResponse = { kind: 'refused', verdict: { kind: 'not-found' } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe("#148 doesn't exist.")
  })

  it('refused: not-an-issue', () => {
    const response: GateAnswerResponse = { kind: 'refused', verdict: { kind: 'not-an-issue' } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe('#148 is a pull request now.')
  })

  it('refused: not-at-plan-review names what GitHub observed', () => {
    const response: GateAnswerResponse = { kind: 'refused', verdict: { kind: 'not-at-plan-review', observed: ['plan approved'] } }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.note).toContain('plan approved')
  })

  it('preflight-failed', () => {
    const response: GateAnswerResponse = { kind: 'preflight-failed', message: 'gh: 401' }
    const copy = resultCopy({ number: 148, decision: 'approve', response, sessionRequired: false })
    expect(copy.line).toBe("Couldn't reach GitHub.")
    expect(copy.note).toBe('gh: 401')
  })
})

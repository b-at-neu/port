import { describe, expect, it } from 'vitest'
import type { ItemDecisionResult, UnblockContext } from '@/types/actions'
import { decisionResultCopy, dialogTitle, unblockCapNote, unblockConsequence, unblockReasonLine } from '@/renderer/decision/copy'

function context(overrides: Partial<UnblockContext> = {}): UnblockContext {
  return { target: 'pull-request', reason: null, cyclesUsed: 0, cap: 5, decisions: [], ...overrides }
}

describe('dialogTitle', () => {
  it('names an issue by its number, whatever the decision', () => {
    expect(dialogTitle('unblock', 548, 'issue')).toBe('Unblock #548')
  })

  it('keeps the pull request wording by default', () => {
    expect(dialogTitle('unblock', 548)).toBe('Unblock PR #548')
    expect(dialogTitle('revise', 548)).toBe('Request changes on PR #548')
  })
})

describe('unblockReasonLine', () => {
  it('points an issue at its blocker comment', () => {
    expect(unblockReasonLine(context({ target: 'issue' }))).toBe("The agent's reason is in the ## Blocker comment on the ticket.")
  })

  it('quotes a pull request escalation reason', () => {
    expect(unblockReasonLine(context({ reason: 'rebase needs a decision' }))).toBe('Why it stopped: rebase needs a decision')
  })

  it('says so when a pull request has no escalation comment', () => {
    expect(unblockReasonLine(context())).toContain('No escalation comment')
  })
})

describe('unblockConsequence', () => {
  it('describes the issue swap back to plan approved and the fresh-run caveat', () => {
    const line = unblockConsequence(context({ target: 'issue' }))
    expect(line).toContain('"## Gate cleared"')
    expect(line).toContain('"blocked" to "plan approved"')
    expect(line).toContain('picks up the branch the last run pushed')
    expect(line).toContain('reads the plan, not comments')
  })

  it('keeps the pull request wording, with and without rebase decisions', () => {
    const decision = { id: 'D1', path: 'a.ts', summary: null, options: [], recommended: null }
    expect(unblockConsequence(context({ decisions: [decision] }))).toContain('sends it to revision')
    expect(unblockConsequence(context())).toContain("Unblocking says you've handled this")
  })
})

describe('unblockCapNote', () => {
  it('never notes a cap for an issue, however many cycles', () => {
    expect(unblockCapNote(context({ target: 'issue', cyclesUsed: 9 }))).toBeNull()
  })

  it('notes the cap only once a pull request has used every cycle', () => {
    expect(unblockCapNote(context({ cyclesUsed: 4 }))).toBeNull()
    expect(unblockCapNote(context({ cyclesUsed: 5 }))).toContain('all 5 review cycles')
  })
})

describe('decisionResultCopy — implementation route', () => {
  const applied: ItemDecisionResult = { ok: true, comment: { kind: 'applied' } as never, labels: { kind: 'applied' } as never }

  it('names the issue without a PR prefix and the implementation dispatch', () => {
    const copy = decisionResultCopy({ number: 548, decision: 'unblock', route: 'implementation', picks: null, response: applied })
    expect(copy.line).toBe('#548 is unblocked and at "plan approved". "## Gate cleared" is posted; the next tick dispatches implementation.')
  })

  it('keeps the PR prefix on the review route', () => {
    const copy = decisionResultCopy({ number: 548, decision: 'unblock', route: 'review', picks: null, response: applied })
    expect(copy.line).toContain('PR #548 is unblocked')
    expect(copy.line).toContain('dispatches review')
  })

  it('uses the issue number in a refusal', () => {
    const copy = decisionResultCopy({ number: 548, decision: 'unblock', route: 'implementation', picks: null, response: { ok: false, reason: 'refused', refusal: 'agent-live' } })
    expect(copy.line).toBe('#548 can no longer be unblocked that way.')
  })

  it('tones an applied swap as a success and every other outcome as an error', () => {
    const params = { number: 548, decision: 'unblock' as const, route: 'review' as const, picks: null }
    expect(decisionResultCopy({ ...params, response: applied }).tone).toBe('success')
    expect(decisionResultCopy({ ...params, response: { ok: false, reason: 'repo-unavailable' } }).tone).toBe('error')
    expect(decisionResultCopy({ ...params, response: { ok: true, comment: { kind: 'applied' } as never, labels: { kind: 'precondition-failed' } as never } }).tone).toBe('error')
  })
})

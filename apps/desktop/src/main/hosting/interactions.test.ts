import { describe, expect, it } from 'vitest'
import { answersMatch, narrowInteraction, planApproveResult, planKeepResult, questionResult } from './interactions'

describe('narrowInteraction', () => {
  it('narrows a well-formed AskUserQuestion input', () => {
    const interaction = narrowInteraction('AskUserQuestion', {
      questions: [{ question: 'Which approach?', header: 'Approach', multiSelect: false, options: [{ label: 'A', description: 'First' }, { label: 'B' }] }],
    })
    expect(interaction).toEqual({
      kind: 'question',
      questions: [{ question: 'Which approach?', header: 'Approach', multiSelect: false, options: [{ label: 'A', description: 'First' }, { label: 'B', description: null }] }],
    })
  })

  it('falls back to null for a malformed AskUserQuestion input (fails open toward the generic dialog)', () => {
    expect(narrowInteraction('AskUserQuestion', { questions: [] })).toBeNull()
    expect(narrowInteraction('AskUserQuestion', { questions: [{ question: 'x', header: 'h', options: [] }] })).toBeNull()
    expect(narrowInteraction('AskUserQuestion', { questions: [{ question: 'x', header: 'h', options: [{ label: 1 }] }] })).toBeNull()
  })

  it('narrows ExitPlanMode, defaulting a missing plan to null', () => {
    expect(narrowInteraction('ExitPlanMode', { plan: 'Step 1\nStep 2' })).toEqual({ kind: 'plan', plan: 'Step 1\nStep 2' })
    expect(narrowInteraction('ExitPlanMode', {})).toEqual({ kind: 'plan', plan: null })
  })

  it('returns null for any other tool', () => {
    expect(narrowInteraction('Bash', { command: 'ls' })).toBeNull()
  })
})

describe('questionResult', () => {
  it('allows with answers merged into the original input', () => {
    expect(questionResult({ questions: [] }, { 'Which approach?': 'A' }, 'tool-1')).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [], answers: { 'Which approach?': 'A' } },
      toolUseID: 'tool-1',
    })
  })
})

describe('planApproveResult / planKeepResult', () => {
  it('approve pins the mode for the session', () => {
    expect(planApproveResult({ plan: 'x' }, 'acceptEdits', 'tool-2')).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'x' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseID: 'tool-2',
    })
  })

  it('keep-planning denies with the operator feedback as the message', () => {
    expect(planKeepResult('Add a step for tests', 'tool-3')).toEqual({ behavior: 'deny', message: 'Add a step for tests', toolUseID: 'tool-3' })
  })
})

describe('answersMatch', () => {
  const interaction = { kind: 'question', questions: [{ question: 'Q1', header: 'H', multiSelect: false, options: [] }, { question: 'Q2', header: 'H', multiSelect: false, options: [] }] } as const

  it('matches when the keys are exactly the pending questions', () => {
    expect(answersMatch(interaction, { Q1: 'a', Q2: 'b' })).toBe(true)
  })

  it('rejects a missing, extra, or renamed key', () => {
    expect(answersMatch(interaction, { Q1: 'a' })).toBe(false)
    expect(answersMatch(interaction, { Q1: 'a', Q2: 'b', Q3: 'c' })).toBe(false)
    expect(answersMatch(interaction, { Q1: 'a', Q3: 'c' })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { controlsChangeFailed, modelLoadFailed, planAnswerFailed, questionAnswerFailed, questionProgress, sidebarDotLabel } from './interaction-copy'

describe('questionProgress', () => {
  it('shows no count for a single question', () => {
    expect(questionProgress(1)).toBe('Claude is asking')
  })

  it('shows "1 of N" when multiple questions arrive in one call', () => {
    expect(questionProgress(2)).toBe('Claude is asking — 1 of 2')
  })
})

describe('failure copy', () => {
  it('names the failure kind once, each', () => {
    expect(questionAnswerFailed('unknown-session')).toBe("Couldn't send your answers: unknown-session.")
    expect(planAnswerFailed('not-a-plan')).toBe("Couldn't send your decision: not-a-plan.")
    expect(controlsChangeFailed('refused')).toBe("Couldn't change the model: refused.")
    expect(modelLoadFailed('timed out')).toBe("Couldn't read the model list: timed out")
  })
})

describe('sidebarDotLabel', () => {
  it('names a question or a plan', () => {
    expect(sidebarDotLabel('question')).toBe('Claude is asking a question')
    expect(sidebarDotLabel('plan')).toBe('Plan ready for review')
  })
})

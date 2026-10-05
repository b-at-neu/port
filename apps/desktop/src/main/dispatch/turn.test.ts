import { describe, expect, it } from 'vitest'
import { DISPATCH_PROMPT, REFRESH_PROMPT, promptFor } from './turn'
import type { TickActionable } from '../../shared/tick/types'

function actionable(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

describe('promptFor', () => {
  it('uses DISPATCH_PROMPT for an ordinary trigger, filling in the number', () => {
    expect(promptFor(actionable())).toBe(DISPATCH_PROMPT.replace('<n>', '52'))
  })

  it('uses REFRESH_PROMPT for a refreshBranch trigger', () => {
    expect(promptFor(actionable({ trigger: 'refreshBranch', agent: 'revise' }))).toBe(REFRESH_PROMPT.replace('<n>', '52'))
  })
})

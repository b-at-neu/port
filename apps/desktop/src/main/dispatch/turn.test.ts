import { describe, expect, it } from 'vitest'
import { DISPATCH_PROMPT, REFRESH_PROMPT, composeDispatchTurn, composeRelayTurn, missingAgentOf, specFor } from './turn'
import type { AgentSummary } from '../../shared/hosting/types'
import type { StageAgent, TickActionable } from '../../shared/tick/types'

function actionable(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

const models: Readonly<Record<StageAgent, string>> = { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' }

function agent(name: string): Pick<AgentSummary, 'name'> {
  return { name }
}

describe('specFor', () => {
  it('builds a spec from a candidate whose agent the session reports', () => {
    const spec = specFor(actionable(), models, [agent('impl-agent')])
    expect(spec).toEqual({
      description: 'impl #52',
      subagentType: 'port:impl-agent',
      model: 'sonnet',
      prompt: DISPATCH_PROMPT.replace('<n>', '52'),
      name: 'impl-52',
      runInBackground: true,
    })
  })

  it('returns null when the session never reported the agent', () => {
    const spec = specFor(actionable(), models, [agent('review-agent')])
    expect(spec).toBeNull()
  })

  it('uses REFRESH_PROMPT for a refreshBranch trigger, DISPATCH_PROMPT otherwise', () => {
    const refresh = specFor(actionable({ trigger: 'refreshBranch', agent: 'revise' }), models, [agent('revise-agent')])
    expect(refresh?.prompt).toBe(REFRESH_PROMPT.replace('<n>', '52'))
    const ordinary = specFor(actionable(), models, [agent('impl-agent')])
    expect(ordinary?.prompt).toBe(DISPATCH_PROMPT.replace('<n>', '52'))
  })

  it('reads the model from the config map, keyed by the candidate\'s own agent', () => {
    const spec = specFor(actionable({ agent: 'review' }), models, [agent('review-agent')])
    expect(spec?.model).toBe('sonnet')
  })
})

describe('composeDispatchTurn', () => {
  it('emits one Agent() call per spec, all in one message, ending in DISPATCHED', () => {
    const spec = specFor(actionable(), models, [agent('impl-agent')])
    if (spec === null) throw new Error('expected a spec')
    const turn = composeDispatchTurn([spec])
    expect(turn).toContain(`Agent(${JSON.stringify(spec)})`)
    expect(turn).toMatch(/DISPATCHED\.?\s*$/)
    expect(turn).toContain('no other tool calls')
  })

  it('joins multiple specs into one message', () => {
    const a = specFor(actionable({ number: 1 }), models, [agent('impl-agent')])
    const b = specFor(actionable({ number: 2, agent: 'review' }), models, [agent('review-agent')])
    if (a === null || b === null) throw new Error('expected both specs')
    const turn = composeDispatchTurn([a, b])
    expect(turn).toContain(`Agent(${JSON.stringify(a)})`)
    expect(turn).toContain(`Agent(${JSON.stringify(b)})`)
  })
})

describe('composeRelayTurn', () => {
  it('emits exactly one SendMessage call with the given agent id and text', () => {
    const turn = composeRelayTurn('impl-52', 'use option B')
    expect(turn).toContain(`SendMessage(${JSON.stringify({ agent_id: 'impl-52', message: 'use option B' })})`)
    expect(turn).toMatch(/DISPATCHED\.?\s*$/)
  })
})

describe('missingAgentOf', () => {
  it('returns null when every candidate resolves', () => {
    const result = missingAgentOf([actionable()], [agent('impl-agent')])
    expect(result).toBeNull()
  })

  it('returns the first candidate\'s agent the session never reported', () => {
    const result = missingAgentOf([actionable({ agent: 'review' }), actionable({ agent: 'impl' })], [agent('impl-agent')])
    expect(result).toBe('review')
  })
})

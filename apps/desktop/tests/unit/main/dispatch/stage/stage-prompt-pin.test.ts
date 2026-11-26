import { describe, expect, it } from 'vitest'
import { promptFor } from '@/main/dispatch/launch'
import { composeStageSystemPrompt, parseStagePrompt, withStageInstructions } from '@/utils/stage/prompt'
import type { PipelineItemKind } from '@/types/github'
import type { StageAgent } from '@/types/tick'
import type { Stage } from '@/utils/pipeline/ticket'

interface Case {
  readonly ticketStage: Stage
  readonly agent: StageAgent
  readonly kind: PipelineItemKind
  readonly stage: StageAgent | 'refresh'
}

const CASES: readonly Case[] = [
  { ticketStage: 'plan', agent: 'plan', kind: 'issue', stage: 'plan' },
  { ticketStage: 'implement', agent: 'impl', kind: 'issue', stage: 'impl' },
  { ticketStage: 'review', agent: 'review', kind: 'pull-request', stage: 'review' },
  { ticketStage: 'revise', agent: 'revise', kind: 'pull-request', stage: 'revise' },
  { ticketStage: 'refresh', agent: 'revise', kind: 'pull-request', stage: 'refresh' },
]

describe('the dispatcher prompt and the stage prompt parser', () => {
  it.each(CASES)('parse what promptFor produces for the $ticketStage stage', ({ ticketStage, agent, kind, stage }) => {
    const header = promptFor({ stage: ticketStage, number: 467, agent, kind })
    const system = composeStageSystemPrompt({ context: [['stage', agent]], instructions: 'body', source: '/plugin' })
    expect(parseStagePrompt(header)).toMatchObject({ stage, kind, number: 467, instructions: null })
    expect(parseStagePrompt(withStageInstructions(header, system))).toEqual({ stage, kind, number: 467, instructions: 'body', source: '/plugin' })
  })
})

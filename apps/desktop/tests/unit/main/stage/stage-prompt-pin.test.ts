import { describe, expect, it } from 'vitest'
import { promptFor } from '@/main/dispatch/dispatcher'
import { composeStagePrompt, parseStagePrompt } from '@/utils/stage/prompt'
import type { PipelineItemKind } from '@/types/github'
import type { StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'

interface Case {
  readonly trigger: LabelKey
  readonly agent: StageAgent
  readonly kind: PipelineItemKind
  readonly stage: StageAgent | 'refresh'
}

const CASES: readonly Case[] = [
  { trigger: 'ready', agent: 'plan', kind: 'issue', stage: 'plan' },
  { trigger: 'planChangesRequested', agent: 'plan', kind: 'issue', stage: 'plan' },
  { trigger: 'planApproved', agent: 'impl', kind: 'issue', stage: 'impl' },
  { trigger: 'readyForReview', agent: 'review', kind: 'pull-request', stage: 'review' },
  { trigger: 'needsRevision', agent: 'revise', kind: 'pull-request', stage: 'revise' },
  { trigger: 'refreshBranch', agent: 'revise', kind: 'pull-request', stage: 'refresh' },
]

describe('the dispatcher prompt and the stage prompt parser', () => {
  it.each(CASES)('parse what promptFor produces for the $trigger trigger', ({ trigger, agent, kind, stage }) => {
    const header = promptFor({ trigger, number: 467, agent, kind })
    const text = composeStagePrompt({ header, context: [['stage', agent]], instructions: 'body', source: '/plugin' })
    expect(parseStagePrompt(header)).toMatchObject({ stage, kind, number: 467, instructions: null })
    expect(parseStagePrompt(text)).toEqual({ stage, kind, number: 467, instructions: 'body', source: '/plugin' })
  })
})

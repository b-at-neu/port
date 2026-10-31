import type { PipelineItemKind } from '@/types/github'
import type { StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'

export const STAGE_PROMPT_NAMES: Readonly<Record<StageAgent, string>> = { plan: 'Plan', impl: 'Implementation', review: 'Review', revise: 'Revision' }
export const KIND_PROMPT_NAMES: Readonly<Record<PipelineItemKind, string>> = { issue: 'issue', 'pull-request': 'pull request' }

export type StageMode = 'fresh' | 'revision' | 'implement' | 'review' | 'revise' | 'refresh'

/** A trigger label's mode is a hint only — every pre-flight still reads the labels. */
const STAGE_MODES: Readonly<Partial<Record<LabelKey, StageMode>>> = {
  ready: 'fresh',
  planChangesRequested: 'revision',
  planApproved: 'implement',
  readyForReview: 'review',
  needsRevision: 'revise',
  refreshBranch: 'refresh',
}

export function stageModeOf(trigger: LabelKey): StageMode | null {
  return STAGE_MODES[trigger] ?? null
}

const CONTEXT_OPEN = '<port-stage-context>'
const CONTEXT_CLOSE = '</port-stage-context>'
const INSTRUCTIONS_CLOSE = '</port-stage-instructions>'

export interface ComposeStagePromptParams {
  readonly header: string
  readonly context: readonly (readonly [key: string, value: string])[]
  readonly instructions: string
  readonly source: string
}

export function composeStagePrompt(params: ComposeStagePromptParams): string {
  const context = params.context.map(([key, value]) => `${key}: ${value}`).join('\n')
  const source = params.source.replaceAll('"', "'")
  return `${params.header}\n\n${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}\n\n<port-stage-instructions source="${source}">\n${params.instructions}\n${INSTRUCTIONS_CLOSE}`
}

export interface ParsedStagePrompt {
  readonly stage: StageAgent | 'refresh'
  readonly kind: PipelineItemKind
  readonly number: number
  readonly instructions: string | null
  readonly source: string | null
}

const STAGE_HEADER = /^(Plan|Implementation|Review|Revision) stage for (issue|pull request) #(\d+)\./
const REFRESH_HEADER = /^Refresh stage for pull request #(\d+)\./
const INSTRUCTIONS_OPEN = /^<port-stage-instructions source="([^"\n]*)">\n/m

const STAGE_BY_NAME: Readonly<Record<string, StageAgent>> = { Plan: 'plan', Implementation: 'impl', Review: 'review', Revision: 'revise' }

/** `null` for any text that does not open with a dispatch header; a missing or unclosed instructions block reads to the end of the text. */
export function parseStagePrompt(text: string): ParsedStagePrompt | null {
  const refresh = REFRESH_HEADER.exec(text)
  const staged = STAGE_HEADER.exec(text)
  const header = refresh ?? staged
  if (header === null) return null
  const stage = refresh !== null ? 'refresh' : STAGE_BY_NAME[staged?.[1] ?? '']
  if (stage === undefined) return null
  const kind: PipelineItemKind = refresh !== null || staged?.[2] === 'pull request' ? 'pull-request' : 'issue'
  const number = Number(refresh !== null ? refresh[1] : staged?.[3])

  const open = INSTRUCTIONS_OPEN.exec(text)
  if (open === null) return { stage, kind, number, instructions: null, source: null }
  const rest = text.slice(open.index + open[0].length)
  const close = rest.lastIndexOf(`\n${INSTRUCTIONS_CLOSE}`)
  return { stage, kind, number, instructions: close === -1 ? rest : rest.slice(0, close), source: open[1] ?? null }
}

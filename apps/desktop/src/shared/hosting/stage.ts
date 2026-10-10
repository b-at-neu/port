// Renderer-safe types for a stage session — a hosted session the app itself launched to run a pipeline stage, never an operator's own.
import type { PipelineItemKind } from '../github/types'
import type { LabelKey } from '../labels/vocabulary'
import type { StageAgent } from '../tick/types'

/** Carried on a stage session's snapshot so the renderer can tell it apart from an operator session without a second lookup. */
export interface StageTag {
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
}

/** A structural read of the SDK's final `result` message. `text` is capped at `SESSION_RESULT_TEXT_CAP` chars, keeping the tail, since the hand-back prefix (`QUESTIONS FOR HUMAN:`/`BLOCKED:`) sits at the end. */
export interface SessionResult {
  readonly subtype: string
  readonly isError: boolean
  readonly text: string | null
  readonly at: string
}

export const SESSION_RESULT_TEXT_CAP = 8000

/** Every hand-back a stage session can end in — `classifyHandback` is the one place that produces one. */
export const STAGE_OUTCOME_KINDS = ['completed', 'questions', 'blocked', 'error', 'usage-limit', 'interrupted'] as const

export type StageOutcomeKind = (typeof STAGE_OUTCOME_KINDS)[number]

/** What happened to the session's worktree once the outcome was classified — `'removed'` only on `completed`. */
export type StageWorktreeOutcome = 'removed' | 'kept' | 'kept-dirty' | 'remove-failed'

export interface StageOutcome {
  readonly kind: StageOutcomeKind
  readonly detail: string | null
  readonly costUsd: number | null
  readonly resetsAt: string | null
  readonly worktree: StageWorktreeOutcome
}

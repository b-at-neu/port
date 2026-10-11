// Renderer-safe types for stage-session "needs you" attention: a denied tool call waiting on an
// allowlist decision, and a stage session interrupted before it reached a hand-back.
import type { PipelineItemKind } from '../github/types'
import type { LabelKey } from '../labels/vocabulary'
import type { StageAgent } from '../tick/types'
import type { RepoId } from '../repos'

/** A single off-allowlist tool call a stage session's policy denied. Deduped per repository by `rule`, bounded to 20, and dropped on relaunch — a repeated denial simply re-raises the item. */
export interface StageDenial {
  readonly id: string
  readonly repoId: RepoId
  readonly agent: StageAgent
  readonly number: number
  readonly toolName: string
  /** Capped at 200 chars — enough to recognize the call, never the whole input. */
  readonly inputSummary: string
  readonly rule: string
  readonly at: string
}

export const INTERRUPTED_REASONS = ['quit', 'crash', 'usage-limit', 'error'] as const
export type InterruptedReason = (typeof INTERRUPTED_REASONS)[number]

/** A stage session that ended without reaching a `completed`/`questions`/`blocked` hand-back — tracked in `stage-sessions.json` until it is resumed, restarted, or the operator clears its label by hand. */
export interface InterruptedStage {
  readonly id: string
  readonly repoId: RepoId
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly inFlight: LabelKey
  readonly model: string
  /** `null` when the session died before the SDK ever minted one — Resume has nothing to resume. */
  readonly claudeSessionId: string | null
  readonly worktree: { readonly path: string; readonly branch: string; readonly baseSha: string }
  readonly startedAt: string
  readonly reason: InterruptedReason
  readonly detail: string | null
  readonly resetsAt: string | null
  readonly costUsd: number | null
}

export type StageAllowResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'already-allowed' }
  | { readonly kind: 'invalid-rule'; readonly reason: string }
  | { readonly kind: 'write-failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'unknown-denial' }

export type StageResumeResult =
  | { readonly kind: 'ok'; readonly sessionKey: string }
  | { readonly kind: 'at-capacity'; readonly limit: number }
  | { readonly kind: 'no-session-id' }
  | { readonly kind: 'start-failed'; readonly message: string }
  | { readonly kind: 'unknown-stage' }

export type StageRestartResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'worktree-dirty' }
  | { readonly kind: 'worktree-remove-failed'; readonly message: string }
  | { readonly kind: 'label-refused'; readonly reason: string }
  | { readonly kind: 'unknown-stage' }

// A hosted session's live controls (mode, model, effort), plus the two
// canUseTool calls narrowed away from the generic permission dialog.
import type { SessionPermissionMode } from './types'

export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type SessionEffort = (typeof SESSION_EFFORTS)[number]

// `null` on any field means Claude Code's own default, never guessed.
export interface SessionControls {
  readonly permissionMode: SessionPermissionMode
  readonly model: string | null
  readonly effort: SessionEffort | null
}

export interface SessionModelOption {
  readonly value: string
  readonly displayName: string
  readonly description: string
  readonly efforts: readonly SessionEffort[]
}

// `pending` before the first read settles; `unavailable` never an empty `ready` list.
export type SessionModels = { readonly kind: 'pending' } | { readonly kind: 'ready'; readonly models: readonly SessionModelOption[] } | { readonly kind: 'unavailable'; readonly message: string }

export interface AskQuestionOption {
  readonly label: string
  readonly description: string | null
}

export interface AskQuestion {
  readonly question: string
  readonly header: string
  readonly multiSelect: boolean
  readonly options: readonly AskQuestionOption[]
}

// `null` on `PendingPermission.interaction` keeps an ordinary tool call routed through the generic dialog.
export type PendingInteraction = { readonly kind: 'question'; readonly questions: readonly AskQuestion[] } | { readonly kind: 'plan'; readonly plan: string | null }

export type SetControlsResult =
  | { readonly ok: true; readonly controls: SessionControls }
  | { readonly ok: false; readonly kind: 'unknown-session' | 'not-ready' | 'unknown-model' | 'unsupported-effort' }
  | { readonly ok: false; readonly kind: 'rejected'; readonly message: string }

// `answers-mismatch` means the keys sent back are not exactly the pending questions' own texts.
export type QuestionAnswerResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' | 'unknown-permission' | 'not-a-question' | 'answers-mismatch' }

export type PlanDecision = { readonly kind: 'approve'; readonly mode: 'default' | 'acceptEdits' } | { readonly kind: 'keep-planning'; readonly feedback: string }

export type PlanAnswerResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' | 'unknown-permission' | 'not-a-plan' }

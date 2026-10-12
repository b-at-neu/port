// Shared view-model types for renderer/session/ — multi-file or test-only.
import type { SessionRateLimit, SessionStartResult } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'

export interface FileLike {
  readonly name: string
  readonly size: number
  readonly type: string
}

export interface StartFailureCopy {
  readonly title: string
  readonly body: string
  readonly detail: string | null
}

// `already-open` is deliberately excluded — that result switches sessions instead of showing a banner.
export type RenderableStartFailure = Extract<SessionStartResult, { readonly ok: false; readonly kind: 'at-capacity' | 'runtime' | 'folder-missing' | 'folder-busy' | 'not-git' | 'worktree-failed' }>

export type NewSessionPreselect = { readonly kind: 'repo'; readonly repoId: RepoId } | { readonly kind: 'path'; readonly path: string } | null

/** Injectable so tests exercise this against a plain fake, never a jsdom `window`. */
export interface PromptHistoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface RecallState {
  /** `null` means not currently recalling — the draft is the operator's own typed text. */
  readonly index: number | null
}

export interface QuestionState {
  readonly selected: ReadonlySet<string>
  readonly other: string
}

export type QuestionsState = readonly QuestionState[]

export interface UsageNotice {
  readonly status: Extract<SessionRateLimit['status'], 'warning' | 'rejected'>
  readonly window: SessionRateLimit['window']
  readonly resetsAt: string | null
}

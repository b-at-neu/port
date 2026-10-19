// Shared view-model types for components/ and their renderer callers — multi-file or test-only.
import type { ReactNode } from 'react'
import type { LabelPalette } from '@/utils/labels/defaults'
import type { FileDiff, ToolDetail, TranscriptEntry } from '@/utils/sessions/transcript'

export interface ComposerAttachmentChip {
  readonly key: string
  readonly name: string
  readonly kind: 'image' | 'pdf' | 'text'
  readonly sizeLabel: string
}

export interface PayloadView {
  readonly text: string
  readonly omittedChars: number
}

export type ToolResultView = { readonly kind: 'none' } | { readonly kind: 'ok'; readonly payload: PayloadView } | { readonly kind: 'error'; readonly payload: PayloadView }

export type RowView =
  | { readonly kind: 'user-text'; readonly uuid: string; readonly text: PayloadView }
  | { readonly kind: 'assistant-text'; readonly uuid: string; readonly text: PayloadView }
  | { readonly kind: 'thinking'; readonly uuid: string; readonly wordCount: number; readonly text: PayloadView }
  | {
      readonly kind: 'tool-call'
      readonly uuid: string
      readonly name: string
      readonly headline: string
      readonly input: PayloadView
      readonly result: ToolResultView
      readonly diff: FileDiff | null
      readonly detail: ToolDetail | null
    }
  | { readonly kind: 'meta'; readonly uuid: string; readonly label: string }

/** One grouped row — a tool call's own children, nested recursively, by `parentToolUseId` matching an earlier row's `toolUseId`. */
export interface GroupedNode {
  readonly entry: TranscriptEntry
  readonly children: readonly GroupedNode[]
  /** `true` when this node's own `parentToolUseId` named a row no longer in the window — its own children still render, just without their parent's row. */
  readonly orphanSubagent: boolean
}

export interface SuggestionRow {
  readonly key: string
  /** A row that cannot be selected still renders, but is skipped by selection — see `selectableKeys`. */
  readonly content: ReactNode
  readonly title?: string
}

export type PillStatus = 'working' | 'attention' | 'success' | 'danger' | 'idle'

/** How a phase indicator paints: a palette (or `unstaged`), a ring for queued versus filled for in flight, and whether it pulses for the operator. */
export interface PhaseTone {
  readonly palette: LabelPalette | 'unstaged'
  readonly fill: 'queued' | 'active'
  readonly pulse: boolean
}

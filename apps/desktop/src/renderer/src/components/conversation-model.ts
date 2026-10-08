// Pure `TranscriptEntry` → view-model mapping, shared by the live session
// view and the on-disk transcript view. `buildRow`'s exact signature is pinned by `scripts/checks/desktop-renderer.ts`.
import type { DiffHunk, FileDiff, Payload, TranscriptEntry } from '../../../shared/sessions/transcript'

export const PROMPT_CLAMP_LINES = 12

export interface PayloadView {
  readonly text: string
  readonly omittedChars: number
}

function payloadView(payload: Payload): PayloadView {
  return { text: payload.text, omittedChars: payload.omittedChars }
}

export type ToolResultView = { readonly kind: 'none' } | { readonly kind: 'ok'; readonly payload: PayloadView } | { readonly kind: 'error'; readonly payload: PayloadView }

export type RowView =
  | { readonly kind: 'user-text'; readonly uuid: string; readonly text: PayloadView }
  | { readonly kind: 'assistant-text'; readonly uuid: string; readonly text: PayloadView }
  | { readonly kind: 'thinking'; readonly uuid: string; readonly wordCount: number; readonly text: PayloadView }
  | { readonly kind: 'tool-call'; readonly uuid: string; readonly name: string; readonly headline: string; readonly input: PayloadView; readonly result: ToolResultView; readonly diff: FileDiff | null }
  | { readonly kind: 'meta'; readonly uuid: string; readonly label: string }

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length
}

function toolResultView(entry: Extract<TranscriptEntry, { type: 'tool-call' }>): ToolResultView {
  if (entry.result === null) return { kind: 'none' }
  return { kind: entry.result.isError ? 'error' : 'ok', payload: payloadView(entry.result.payload) }
}

export function buildRow(entry: TranscriptEntry): RowView {
  switch (entry.type) {
    case 'user-text':
      return { kind: 'user-text', uuid: entry.uuid, text: payloadView(entry.text) }
    case 'assistant-text':
      return { kind: 'assistant-text', uuid: entry.uuid, text: payloadView(entry.text) }
    case 'thinking':
      return { kind: 'thinking', uuid: entry.uuid, wordCount: wordCount(entry.text.text), text: payloadView(entry.text) }
    case 'tool-call':
      return { kind: 'tool-call', uuid: entry.uuid, name: entry.name, headline: entry.headline, input: payloadView(entry.input), result: toolResultView(entry), diff: entry.diff }
    case 'meta':
      return { kind: 'meta', uuid: entry.uuid, label: entry.label }
  }
}

export function diffSummary(diff: FileDiff): string {
  return `${diff.isNewFile ? '(new file) ' : ''}${diff.path}  +${String(diff.additions)} -${String(diff.deletions)}`
}

export function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`
}

// Pure `TranscriptEntry` → view-model mapping, shared by the live session
// view and the on-disk transcript view. `buildRow`'s exact signature is pinned by `scripts/checks/desktop-renderer.ts`.
import type { DiffHunk, FileDiff, Payload, ToolDetail, TranscriptEntry } from '../../../shared/sessions/transcript'

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
      return { kind: 'tool-call', uuid: entry.uuid, name: entry.name, headline: entry.headline, input: payloadView(entry.input), result: toolResultView(entry), diff: entry.diff, detail: entry.detail ?? null }
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

/** An entry whose `parentToolUseId` matches an earlier entry's own `toolUseId` becomes that row's child, recursively. An orphan (its parent evicted from the window) stays top-level, flagged `orphanSubagent`. */
export function groupEntries(entries: readonly TranscriptEntry[]): readonly GroupedNode[] {
  const nodeByToolUseId = new Map<string, GroupedNode>()
  const childrenByParent = new Map<string, GroupedNode[]>()
  const roots: GroupedNode[] = []

  // First pass: build every node, bucketing by parentToolUseId.
  const built = entries.map((entry): GroupedNode => {
    const node: GroupedNode = { entry, children: [], orphanSubagent: false }
    if (entry.type === 'tool-call' && entry.toolUseId !== undefined) nodeByToolUseId.set(entry.toolUseId, node)
    return node
  })

  for (const node of built) {
    const parentId = node.entry.parentToolUseId
    if (parentId === undefined) {
      roots.push(node)
      continue
    }
    const siblings = childrenByParent.get(parentId)
    if (siblings === undefined) childrenByParent.set(parentId, [node])
    else siblings.push(node)
  }

  // Second pass: attach each parent's children (mutating the children array in place), falling back to top-level with orphanSubagent when the parent never showed up.
  function attachChildren(node: GroupedNode): GroupedNode {
    const toolUseId = node.entry.type === 'tool-call' ? node.entry.toolUseId : undefined
    const kids = (toolUseId !== undefined ? childrenByParent.get(toolUseId) : undefined) ?? []
    return { ...node, children: kids.map(attachChildren) }
  }

  const resolvedRoots = roots.map(attachChildren)
  for (const [parentId, kids] of childrenByParent) {
    if (nodeByToolUseId.has(parentId)) continue
    for (const kid of kids) resolvedRoots.push({ ...attachChildren(kid), orphanSubagent: true })
  }
  // Stable chronological order even once orphans are appended at the end.
  return resolvedRoots.slice().sort((a, b) => entries.indexOf(a.entry) - entries.indexOf(b.entry))
}

function pluralize(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** The tool row's own one-line result summary (right side, DESIGN §4). `stepCount` is a Task/Agent row's own nested child count. */
export function toolSummary(row: Extract<RowView, { readonly kind: 'tool-call' }>, stepCount = 0): string {
  const detail = row.detail
  if (detail?.kind === 'bash') {
    if (detail.interrupted) return 'interrupted'
    if (detail.exitCode !== null) return `exit ${String(detail.exitCode)}`
    if (row.result.kind === 'error') return 'error'
    if (row.result.kind === 'ok') return 'done'
    return 'no result'
  }
  if (detail?.kind === 'lookup') {
    if (detail.count === null) return 'no result'
    if (row.name === 'Grep') return detail.count === 0 ? 'No matches' : `${String(detail.count)} match${detail.count === 1 ? '' : 'es'}`
    if (row.name === 'Glob') return detail.count === 0 ? 'No files' : pluralize(detail.count, 'file')
    return pluralize(detail.count, 'line')
  }
  if (detail?.kind === 'todos') {
    const done = detail.items.filter((item) => item.status === 'completed').length
    return `${String(done)} of ${String(detail.items.length)} done`
  }
  if (detail?.kind === 'task') {
    if (row.result.kind === 'error') return 'error'
    const status = row.result.kind === 'ok' ? 'done' : 'running'
    return `${pluralize(stepCount, 'step')} · ${status}`
  }
  if (row.result.kind === 'none') return 'no result'
  return row.result.kind === 'error' ? 'error' : 'ok'
}

/** Which tool cards start expanded (DESIGN §4): edits with a diff, TodoWrite, a running Task/Agent, and a failed Bash. */
export function defaultOpen(row: Extract<RowView, { readonly kind: 'tool-call' }>): boolean {
  if (row.diff !== null) return true
  if (row.detail?.kind === 'todos') return true
  if (row.detail?.kind === 'task') return row.result.kind === 'none'
  if (row.detail?.kind === 'bash') return row.result.kind === 'error'
  return false
}

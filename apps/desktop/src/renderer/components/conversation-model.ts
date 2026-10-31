// Pure `TranscriptEntry` → view-model mapping, shared by the live session
// view and the on-disk transcript view. `buildRow`'s exact signature is pinned by `scripts/checks/desktop-renderer.ts`.
import type { DiffHunk, FileDiff, Payload, TranscriptEntry } from '@/utils/sessions/transcript'
import type { GroupedNode, PayloadView, RowView, ToolResultView } from '@/types/components'
import { STAGE_PROMPT_NAMES, parseStagePrompt } from '@/utils/stage/prompt'

export const PROMPT_CLAMP_LINES = 12

/** An issue reads as a ticket, a pull request as a PR (DESIGN §6). */
export function stageCardTitle(row: Extract<RowView, { readonly kind: 'stage-prompt' }>): string {
  const name = row.stage === 'refresh' ? 'Refresh' : STAGE_PROMPT_NAMES[row.stage]
  return `${name} stage · ${row.itemKind === 'issue' ? 'ticket #' : 'PR#'}${String(row.number)}`
}

function payloadView(payload: Payload): PayloadView {
  return { text: payload.text, omittedChars: payload.omittedChars }
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
    case 'user-text': {
      const stagePrompt = parseStagePrompt(entry.text.text)
      if (stagePrompt === null) return { kind: 'user-text', uuid: entry.uuid, text: payloadView(entry.text) }
      const instructions = stagePrompt.instructions === null ? null : { text: stagePrompt.instructions, omittedChars: entry.text.omittedChars }
      return { kind: 'stage-prompt', uuid: entry.uuid, stage: stagePrompt.stage, itemKind: stagePrompt.kind, number: stagePrompt.number, instructions, source: stagePrompt.source }
    }
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

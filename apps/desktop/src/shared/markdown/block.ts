// Block parse (#92) — pure, no DOM, no `node:` import (`shared/markdown/`
// compiles under `typecheck:web`). Recognizes exactly the bounded subset the
// plan decided: ATX headings, paragraphs, fenced code, blockquote, `-`/`*`
// and `1.` lists with one level of nesting and GitHub task items, GFM pipe
// tables, thematic breaks. Anything else — raw HTML, images, footnotes,
// reference links, deeper nesting — is never specially recognized, so it
// falls into an ordinary paragraph's own literal `text` inline nodes:
// rendered as characters via `textContent`, never dropped, never
// interpreted.
import { parseInline } from './inline'
import type { BlockNode, ListItem, TableAlign, TableRow } from './types'

const ATX_HEADING = /^(#{1,6})\s+(.*)$/
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/
const FENCE = /^(`{3,}|~{3,})\s*(\S*)\s*$/
const BLOCKQUOTE_LINE = /^>\s?(.*)$/
const UNORDERED_ITEM = /^(\s*)[-*]\s+(.*)$/
const ORDERED_ITEM = /^(\s*)\d+\.\s+(.*)$/
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/
const TABLE_DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isBlockStart(line: string): boolean {
  return ATX_HEADING.test(line) || THEMATIC_BREAK.test(line.trim()) || FENCE.test(line) || BLOCKQUOTE_LINE.test(line) || UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line)
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length
}

function splitTableRow(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/** A blank line or the start of anything block-shaped stops a paragraph — a
 *  paragraph is one inline run in this bounded subset, its source lines
 *  joined with a single space, never preserved line-by-line. */
function paragraphLines(lines: readonly string[], start: number): { readonly text: string; readonly next: number } {
  const collected: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || isBlank(line)) break
    if (isBlockStart(line)) break
    collected.push(line.trim())
    i++
  }
  return { text: collected.join(' '), next: i }
}

function parseFence(lines: readonly string[], start: number): { readonly node: BlockNode; readonly next: number } {
  const openLine = lines[start] ?? ''
  const openMatch = FENCE.exec(openLine)
  const marker = (openMatch?.[1] ?? '`').charAt(0)
  const language = openMatch?.[2]?.trim()
  const code: string[] = []
  let i = start + 1
  const closeRe = new RegExp(`^${marker}{3,}\\s*$`)
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break
    if (closeRe.test(line.trim())) {
      i++
      break
    }
    code.push(line)
    i++
  }
  return { node: { kind: 'code', language: language && language !== '' ? language : null, code: code.join('\n') }, next: i }
}

function parseBlockquote(lines: readonly string[], start: number): { readonly node: BlockNode; readonly next: number } {
  const inner: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break
    const match = BLOCKQUOTE_LINE.exec(line)
    if (!match) break
    inner.push(match[1] ?? '')
    i++
  }
  return { node: { kind: 'blockquote', children: parseMarkdown(inner.join('\n')) }, next: i }
}

/** Collects one list's worth of top-level items. A following line indented
 *  more than its own item's marker becomes that item's `children` — one
 *  level of nested list, dedented and re-parsed as its own `parseList` call,
 *  never a second level (the plan's own bounded subset). */
function parseList(lines: readonly string[], start: number, ordered: boolean): { readonly node: BlockNode; readonly next: number } {
  const items: ListItem[] = []
  const markerRe = ordered ? ORDERED_ITEM : UNORDERED_ITEM
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || isBlank(line)) break
    const match = markerRe.exec(line)
    if (!match) break
    const indent = leadingSpaces(line)
    let rest = match[2] ?? ''
    i++

    const nestedRaw: string[] = []
    while (i < lines.length) {
      const next = lines[i]
      if (next === undefined || isBlank(next)) break
      if (leadingSpaces(next) <= indent) break
      nestedRaw.push(next)
      i++
    }

    const taskMatch = TASK_ITEM.exec(rest)
    const checked = taskMatch ? taskMatch[1]?.toLowerCase() === 'x' : null
    if (taskMatch) rest = taskMatch[2] ?? ''

    let children: readonly BlockNode[] = []
    if (nestedRaw.length > 0) {
      const first = nestedRaw[0] ?? ''
      const nestedOrdered = ORDERED_ITEM.test(first)
      const nestedIndent = leadingSpaces(first)
      const dedented = nestedRaw.map((raw) => raw.slice(Math.min(nestedIndent, leadingSpaces(raw))))
      children = [parseList(dedented, 0, nestedOrdered).node]
    }

    items.push({ inline: parseInline(rest), checked, children })
  }

  return { node: { kind: 'list', ordered, items }, next: i }
}

function toAlign(cell: string): TableAlign {
  const trimmed = cell.trim()
  const left = trimmed.startsWith(':')
  const right = trimmed.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/** GFM pipe table: a header row immediately followed by a delimiter row
 *  (`---`/`:--`/`--:`/`:-:` per cell) — `null` when the second line is not a
 *  delimiter row at all, so the caller falls back to an ordinary paragraph. */
function parseTable(lines: readonly string[], start: number): { readonly node: BlockNode; readonly next: number } | null {
  const headerLine = lines[start]
  const delimiterLine = lines[start + 1]
  if (headerLine === undefined || delimiterLine === undefined) return null
  if (!headerLine.includes('|') || !TABLE_DELIMITER_ROW.test(delimiterLine.trim())) return null

  const align = splitTableRow(delimiterLine).map(toAlign)
  const header: TableRow = splitTableRow(headerLine).map(parseInline)

  const rows: TableRow[] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || isBlank(line) || !line.includes('|')) break
    rows.push(splitTableRow(line).map(parseInline))
    i++
  }

  return { node: { kind: 'table', header, align, rows }, next: i }
}

export function parseMarkdown(src: string): readonly BlockNode[] {
  const lines = src.split(/\r?\n/)
  const blocks: BlockNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || isBlank(line)) {
      i++
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      const level = (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ kind: 'heading', level, inline: parseInline(heading[2] ?? '') })
      i++
      continue
    }

    if (THEMATIC_BREAK.test(line.trim())) {
      blocks.push({ kind: 'thematic-break' })
      i++
      continue
    }

    if (FENCE.test(line)) {
      const fence = parseFence(lines, i)
      blocks.push(fence.node)
      i = fence.next
      continue
    }

    if (BLOCKQUOTE_LINE.test(line)) {
      const quote = parseBlockquote(lines, i)
      blocks.push(quote.node)
      i = quote.next
      continue
    }

    if (UNORDERED_ITEM.test(line)) {
      const list = parseList(lines, i, false)
      blocks.push(list.node)
      i = list.next
      continue
    }

    if (ORDERED_ITEM.test(line)) {
      const list = parseList(lines, i, true)
      blocks.push(list.node)
      i = list.next
      continue
    }

    const table = parseTable(lines, i)
    if (table) {
      blocks.push(table.node)
      i = table.next
      continue
    }

    const paragraph = paragraphLines(lines, i)
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.text) })
    i = paragraph.next
  }

  return blocks
}

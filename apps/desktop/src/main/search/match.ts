// Entry -> searchable fields, and fields -> hits (#87). Pure over a
// `TranscriptEntry[]` already parsed by `main/sessions/` -- no filesystem, no
// signature, nothing about scope or budget. `query.ts` is the only caller.
import type { SearchField, SearchHit, SearchSnippet } from '../../shared/search/types'
import type { FileDiff, TranscriptEntry } from '../../shared/sessions/transcript'
import { foldCase } from './terms'

/** Either side of a match, in the original (unfolded) text -- generous
 *  enough to show a path or an error in context without dumping a whole
 *  payload into one row. */
const SNIPPET_CONTEXT_CHARS = 60

export interface SearchableField {
  readonly field: SearchField
  readonly text: string
}

function diffText(diff: FileDiff): string {
  const lines = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
  return [diff.path, ...lines].join('\n')
}

/** `text` for the three text-kind entries; `name`/`headline`/`input` always
 *  for a tool call, plus `result`/`diff` only when that entry actually
 *  carries one -- an unpaired tool call (no result yet) contributes fewer
 *  fields, never an empty placeholder one. `diff`'s text is the path plus
 *  every hunk line, so a query for a changed line's content matches the same
 *  way a query for its file path does. */
export function searchableFields(entry: TranscriptEntry): readonly SearchableField[] {
  switch (entry.type) {
    case 'user-text':
    case 'assistant-text':
    case 'thinking':
      return [{ field: 'text', text: entry.text.text }]
    case 'meta':
      return [{ field: 'label', text: entry.label }]
    case 'tool-call': {
      const fields: SearchableField[] = [
        { field: 'name', text: entry.name },
        { field: 'headline', text: entry.headline },
        { field: 'input', text: entry.input.text },
      ]
      if (entry.result !== null) fields.push({ field: 'result', text: entry.result.payload.text })
      if (entry.diff !== null) fields.push({ field: 'diff', text: diffText(entry.diff) })
      return fields
    }
  }
}

function snippetFor(text: string, matchStart: number, matchLength: number): SearchSnippet {
  const start = Math.max(0, matchStart - SNIPPET_CONTEXT_CHARS)
  const end = Math.min(text.length, matchStart + matchLength + SNIPPET_CONTEXT_CHARS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return { text: `${prefix}${text.slice(start, end)}${suffix}`, matchStart: matchStart - start + prefix.length, matchLength }
}

/**
 * Every entry where **all** `terms` (already folded, via `parseQuery`)
 * appear in *some* field of it -- AND across the entry, never the field, so
 * a path in a tool call's headline and an error string in its result both
 * count toward the same hit. One `SearchHit` per matching entry, anchored on
 * the first term's first match in whichever field it appeared in first --
 * which field or term produced a *later* match is not reported, since the
 * point is "this entry matched", not a ranked explanation.
 */
export function hitsFor(entries: readonly TranscriptEntry[], terms: readonly string[]): readonly SearchHit[] {
  if (terms.length === 0) return []
  const hits: SearchHit[] = []

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry === undefined) continue
    const folded = searchableFields(entry).map((field) => ({ ...field, folded: foldCase(field.text) }))

    if (!terms.every((term) => folded.some((field) => field.folded.includes(term)))) continue

    const anchorTerm = terms[0]
    if (anchorTerm === undefined) continue
    const anchorField = folded.find((field) => field.folded.includes(anchorTerm))
    if (anchorField === undefined) continue // unreachable: the `every` above already found it
    const matchStart = anchorField.folded.indexOf(anchorTerm)

    hits.push({
      entryIndex: index,
      kind: entry.type,
      toolName: entry.type === 'tool-call' ? entry.name : null,
      field: anchorField.field,
      timestamp: entry.timestamp,
      snippet: snippetFor(anchorField.text, matchStart, anchorTerm.length),
    })
  }

  return hits
}

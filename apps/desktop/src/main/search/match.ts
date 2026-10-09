// Pure over a `TranscriptEntry[]` already parsed by `main/sessions/` -- no filesystem, no signature.
import type { SearchField, SearchHit, SearchSnippet } from '../../shared/search/types'
import type { FileDiff, TranscriptEntry } from '../../shared/sessions/transcript'
import { foldCase, indexOfFolded } from './terms'

// Either side of a match, in the original (unfolded) text.
const SNIPPET_CONTEXT_CHARS = 60

export interface SearchableField {
  readonly field: SearchField
  readonly text: string
}

function diffText(diff: FileDiff): string {
  const lines = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
  return [diff.path, ...lines].join('\n')
}

/** An unpaired tool call (no result yet) contributes fewer fields, never an empty placeholder one. */
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

// AND across the entry, never the field. One `SearchHit` per matching entry, anchored on the
// first term's first match.
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
    const matchStart = indexOfFolded(anchorField.text, anchorTerm)

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

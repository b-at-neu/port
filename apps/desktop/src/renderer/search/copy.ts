// Every string the Search screen renders — pure, no DOM.
import type { SearchGroup, SearchHit, SearchResult } from '../../../shared/search/types'

export const IDLE_NOTICE = 'port reads transcripts from this machine only. Nothing is sent anywhere.'
export const TOO_SHORT_COPY = 'Enter at least 3 characters — shorter terms match nearly everything.'
export const SEARCHING_COPY = 'The first pass over a transcript reads it once and remembers it, so this is the slow one.'
export const SEARCH_HINT = 'Terms are combined with AND and match anywhere, case-insensitively. Wrap a phrase in "quotes".'

export function kindChip(hit: SearchHit): string {
  if (hit.toolName !== null) return hit.toolName
  switch (hit.kind) {
    case 'user-text':
      return 'Prompt'
    case 'assistant-text':
      return 'Claude'
    case 'thinking':
      return 'Thinking'
    case 'meta':
      return 'System'
    case 'tool-call':
      return 'Tool'
  }
}

export function errorCopy(kind: 'invalid-query' | 'sessions-unavailable', message: string | null): string {
  return kind === 'sessions-unavailable' ? `port couldn't list local sessions, so there is nothing to search: ${message ?? ''}` : TOO_SHORT_COPY
}

export function groupHeader(group: SearchGroup, relativeAge: string): string {
  return [group.label, group.itemNumber !== null ? `#${String(group.itemNumber)}` : null, group.agentId !== null ? 'agent' : null, relativeAge, `${String(group.hitCount)} matches`]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

export function emptyCopy(result: Extract<SearchResult, { ok: true }>): string {
  return result.complete ? `No matches in ${String(result.inScope)} transcripts.` : `No matches yet in ${String(result.read)} of ${String(result.inScope)} transcripts — the time budget ran out before the rest.`
}

export function summaryLine(result: Extract<SearchResult, { ok: true }>): string {
  const totalHits = result.groups.reduce((sum, group) => sum + group.hitCount, 0)
  return `${String(totalHits)} matches in ${String(result.groups.length)} transcripts · ${String(result.skippedByIndex)} skipped from the index, ${String(result.read)} read · ${String(result.tookMs)} ms`
}

export function footnotes(result: Extract<SearchResult, { ok: true }>): readonly string[] {
  const notes: string[] = []
  if (result.unreached > 0) notes.push(`${String(result.unreached)} transcripts weren't reached before the time budget. Search again to continue — the ones just read are now indexed.`)
  if (result.hitsTruncated) notes.push('Only the first 20 matches per transcript are listed.')
  if (!result.indexPersisted) notes.push("The search index couldn't be saved, so the next search will be as slow as this one.")
  return notes
}

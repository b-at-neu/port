// `foldCase` is length-preserving, so every offset `indexOfFolded` reports stays aligned to the
// original, untouched text.
import { MIN_TERM_CHARS } from '../../shared/search/types'

/** A code point whose lowercase mapping expands (German `ß` -> `ss`, ...) keeps its original
 *  form, so folding never changes the string's length. */
export function foldCase(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    out += [...lower].length === 1 ? lower : ch
  }
  return out
}

/** `foldedTerm` must already be folded by the caller — comparing a folded haystack against an
 *  unfolded term would silently never match. */
export function indexOfFolded(haystack: string, foldedTerm: string, fromIndex = 0): number {
  return foldCase(haystack).indexOf(foldedTerm, fromIndex)
}

export interface ParsedQuery {
  /** Already folded and filtered to `MIN_TERM_CHARS` or longer. */
  readonly terms: readonly string[]
}

// Whitespace-separated terms; a `"…"` run is one phrase term.
const PHRASE_OR_WORD = /"([^"]*)"|(\S+)/g

export function parseQuery(raw: string): ParsedQuery {
  const terms: string[] = []
  for (const match of raw.matchAll(PHRASE_OR_WORD)) {
    const piece = (match[1] ?? match[2] ?? '').trim()
    if (piece === '') continue
    const folded = foldCase(piece)
    if (folded.length >= MIN_TERM_CHARS) terms.push(folded)
  }
  return { terms }
}

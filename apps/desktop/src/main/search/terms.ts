// Query parsing and case folding (#87). `foldCase` is length-preserving --
// every offset `indexOfFolded` reports into a folded string is the same
// offset into the original, untouched text, which is what lets a snippet be
// sliced straight out of the source rather than a second, unfolded pass.
import { MIN_TERM_CHARS } from '../../shared/search/types'

/** Per code point: a code point whose lowercase mapping is not exactly one
 *  code point (German `ß` -> `ss`, Turkish `İ` -> `i̇`, ...) keeps its
 *  original form instead of expanding, so folding never changes the string's
 *  length and every offset stays aligned to the original text. */
export function foldCase(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    out += [...lower].length === 1 ? lower : ch
  }
  return out
}

/** Case-insensitive `indexOf`: folds `haystack` and searches it for
 *  `foldedTerm`, which the caller must already have folded itself (via
 *  `foldCase`) -- comparing a folded haystack against an unfolded term would
 *  silently never match. Because folding preserves length, the index
 *  returned is valid against the original, unfolded `haystack` too. */
export function indexOfFolded(haystack: string, foldedTerm: string, fromIndex = 0): number {
  return foldCase(haystack).indexOf(foldedTerm, fromIndex)
}

export interface ParsedQuery {
  /** Already folded and already filtered to `MIN_TERM_CHARS` or longer --
   *  every downstream consumer (the trigram filter, the entry matcher) reads
   *  these as the whole term list, never re-deriving or re-filtering them. */
  readonly terms: readonly string[]
}

/** Whitespace-separated terms; a `"…"` run is one phrase term. Each is
 *  folded, then dropped if it falls under `MIN_TERM_CHARS` -- a query that
 *  parses to zero usable terms is the caller's `invalid-query` signal, not
 *  this function's problem to report. */
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

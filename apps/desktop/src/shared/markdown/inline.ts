// Inline parse and the link-scheme allowlist (#92) — pure, no DOM, no
// `node:` import (`shared/markdown/` compiles under `typecheck:web`).
// Anything not recognized by one of the matchers below is literal text;
// literal runs are always coalesced, never emitted one character at a time.
import type { InlineNode } from './types'

/** The one allowlist deciding whether `[text](href)` becomes a `link` node
 *  at all — every other scheme (`javascript:`, `mailto:`, a bare relative
 *  path) renders as the literal source text instead, since a `javascript:`
 *  href in an Electron renderer is a code-execution sink and a relative
 *  GitHub path would be broken anyway. */
const LINK_SCHEMES = ['http://', 'https://']

function isAllowedHref(href: string): boolean {
  return LINK_SCHEMES.some((scheme) => href.startsWith(scheme))
}

interface Match {
  readonly node: InlineNode
  readonly length: number
}

/** Code span: `` `...` `` — no inline parsing inside, and the delimiter can
 *  be a run of one or more backticks, closed only by a run of the same
 *  length (CommonMark's own escape for embedding a literal backtick). */
function matchCodeSpan(src: string, at: number): Match | null {
  if (src[at] !== '`') return null
  let run = 0
  while (src[at + run] === '`') run++
  const opening = src.slice(at, at + run)
  const closeIdx = src.indexOf(opening, at + run)
  if (closeIdx === -1) return null
  const inner = src.slice(at + run, closeIdx)
  return { node: { kind: 'code', value: inner.trim() }, length: closeIdx + run - at }
}

function matchStrong(src: string, at: number): Match | null {
  if (!src.startsWith('**', at)) return null
  const closeIdx = src.indexOf('**', at + 2)
  if (closeIdx === -1 || closeIdx === at + 2) return null
  const inner = src.slice(at + 2, closeIdx)
  return { node: { kind: 'strong', children: parseInline(inner) }, length: closeIdx + 2 - at }
}

/** Declines whenever `matchStrong` would also match (`src[at + 1] === '*'`)
 *  — `parseInline`'s own ordering tries `matchStrong` first, but a `**` with
 *  no closing run must still fall through to a single literal `*`, never a
 *  misparsed emphasis span starting mid-delimiter. */
function matchEmphasis(src: string, at: number): Match | null {
  if (src[at] !== '*' || src[at + 1] === '*') return null
  const closeIdx = src.indexOf('*', at + 1)
  if (closeIdx === -1 || closeIdx === at + 1) return null
  const inner = src.slice(at + 1, closeIdx)
  return { node: { kind: 'emphasis', children: parseInline(inner) }, length: closeIdx + 1 - at }
}

/** The `)` that closes `(href)`, tracking nested-paren depth so a href
 *  containing its own balanced parentheses (a `javascript:alert(1)` sink, or
 *  an ordinary URL with one) is not truncated at the first `)` — matches
 *  `-1` only for a genuinely unclosed span. */
function findLinkClose(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

/** `[text](href)` — an unrecognized href scheme still consumes the whole
 *  span, but emits it back as the literal `text` node it would have rendered
 *  as anyway, never a `link` node with an inert href. Declines outright when
 *  immediately preceded by `!` — image syntax is not in the bounded subset
 *  (plan's own decided rule), so `![alt](url)` must render as literal text,
 *  never as a clickable link with the `!` orphaned in front of it. */
function matchLink(src: string, at: number): Match | null {
  if (src[at] !== '[') return null
  if (src[at - 1] === '!') return null
  const textEnd = src.indexOf(']', at + 1)
  if (textEnd === -1 || src[textEnd + 1] !== '(') return null
  const hrefEnd = findLinkClose(src, textEnd + 2)
  if (hrefEnd === -1) return null
  const text = src.slice(at + 1, textEnd)
  const href = src.slice(textEnd + 2, hrefEnd)
  const length = hrefEnd + 1 - at
  if (!isAllowedHref(href)) {
    return { node: { kind: 'text', value: src.slice(at, hrefEnd + 1) }, length }
  }
  return { node: { kind: 'link', text, href }, length }
}

export function parseInline(src: string): readonly InlineNode[] {
  const nodes: InlineNode[] = []
  let literal = ''
  let i = 0

  function flushLiteral(): void {
    if (literal !== '') {
      nodes.push({ kind: 'text', value: literal })
      literal = ''
    }
  }

  while (i < src.length) {
    const match = matchCodeSpan(src, i) ?? matchStrong(src, i) ?? matchEmphasis(src, i) ?? matchLink(src, i)
    if (match !== null) {
      flushLiteral()
      nodes.push(match.node)
      i += match.length
      continue
    }
    literal += src[i] ?? ''
    i++
  }
  flushLiteral()
  return nodes
}

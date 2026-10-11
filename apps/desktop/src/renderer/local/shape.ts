// Split out of `inspect.ts` once that file crossed the line limit — the shape grammar has no dependency on the rest of the inspector.
const SHAPE_MAX_TOKENS = 4
const SHAPE_MAX_LENGTH = 80
const PATH_PLACEHOLDER = '<path>'
const ARG_PLACEHOLDER = '<arg>'
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:@-]*$/
const ALL_DIGITS_PATTERN = /^\d+$/

/** Order matters: a path-shaped token is recognised before the identifier test, since a path can otherwise contain identifier-safe characters. */
function mapToken(token: string): string {
  if (token.includes('/') || token.includes('\\')) return PATH_PLACEHOLDER
  if (IDENTIFIER_PATTERN.test(token)) return token
  return ARG_PLACEHOLDER
}

function isPlaceholder(token: string): boolean {
  return token === PATH_PLACEHOLDER || token === ARG_PLACEHOLDER
}

/** A pure lexical normalizer, never a parse — collapses the volatile parts of a subject so the same repeated command reads as one group. */
export function shapeOf(subject: string): string {
  const collapsed = subject.trim().replace(/\s+/g, ' ')
  if (collapsed === '') return '(empty)'

  const mapped: string[] = []
  for (const token of collapsed.split(' ')) {
    if (token.startsWith('-')) continue // a flag (--json labels vs --json title) must not fragment a group
    if (ALL_DIGITS_PATTERN.test(token)) continue // an issue number must not fragment a group
    mapped.push(mapToken(token))
  }

  // Consecutive identical placeholders collapse to one — done before the 4-token keep, or a run of placeholders could crowd out a real token after it.
  const deduped: string[] = []
  for (const token of mapped) {
    const prev = deduped[deduped.length - 1]
    if (prev !== undefined && prev === token && isPlaceholder(token)) continue
    deduped.push(token)
  }

  const joined = deduped.slice(0, SHAPE_MAX_TOKENS).join(' ')
  return joined.length > SHAPE_MAX_LENGTH ? joined.slice(0, SHAPE_MAX_LENGTH) : joined
}

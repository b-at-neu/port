// Rejects a shell metacharacter or unbalanced quote outright and accepts only a `node` prefix —
// reject rather than interpret.
const METACHARACTERS = new Set(['|', '&', ';', '<', '>', '$', '`', '(', ')'])

export type TokenizeResult =
  | { readonly ok: true; readonly binary: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly kind: 'unparseable-command' }
  | { readonly ok: false; readonly kind: 'unsupported-runner'; readonly token: string }

// Never interprets an escape sequence — an adopter's config is a plain string, not a shell script.
function tokenize(prefix: string): readonly string[] | null {
  const tokens: string[] = []
  let current = ''
  let hasCurrent = false
  let quote: '"' | "'" | null = null

  for (const ch of prefix) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasCurrent = true
      continue
    }
    if (METACHARACTERS.has(ch)) {
      return null
    }
    if (/\s/.test(ch)) {
      if (hasCurrent) {
        tokens.push(current)
        current = ''
        hasCurrent = false
      }
      continue
    }
    current += ch
    hasCurrent = true
  }

  if (quote !== null) return null // unbalanced quote
  if (hasCurrent) tokens.push(current)
  return tokens
}

// Accepts it only when the first token is exactly `node`. Never spawns anything; the caller decides
// what to do with a successful result.
export function parseNodeCommand(prefix: string): TokenizeResult {
  const tokens = tokenize(prefix)
  if (tokens === null || tokens.length === 0) return { ok: false, kind: 'unparseable-command' }

  const [binary, ...args] = tokens
  if (binary !== 'node') return { ok: false, kind: 'unsupported-runner', token: binary ?? '' }

  return { ok: true, binary, args }
}

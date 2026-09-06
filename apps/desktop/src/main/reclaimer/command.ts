// Tokenizes and validates `commands.worktrees` — a free-form command-prefix
// string a repository's config carries verbatim. `KNOWN_COMMANDS` in
// `main/platform/run.ts` is a literal union precisely so an adapter cannot
// reach for an arbitrary binary (ENGINEERING §1), so this rejects a shell
// metacharacter or unbalanced quote outright and accepts only a `node`
// prefix — reject rather than interpret, since a metacharacter means the
// operator wrote something a shell would do and this layer will not.

/** Every character this layer refuses to interpret when it appears outside
 *  a quoted span — each one is something a real shell would give special
 *  meaning to, which this tokenizer deliberately does not implement. */
const METACHARACTERS = new Set(['|', '&', ';', '<', '>', '$', '`', '(', ')'])

export type TokenizeResult =
  | { readonly ok: true; readonly binary: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly kind: 'unparseable-command' }
  | { readonly ok: false; readonly kind: 'unsupported-runner'; readonly token: string }

/** Whitespace outside a quoted span splits tokens; single and double quotes
 *  both open a span that consumes metacharacters and whitespace literally,
 *  closed only by a matching quote of the same kind. Never interprets an
 *  escape sequence — an adopter's config is a plain string, not a shell
 *  script. */
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

/** Tokenizes `commands.worktrees` and accepts it only when the first token
 *  is exactly `node` — every schema example and every `/port:init` install
 *  is `node <script>`, so this rejects nothing real. Never spawns anything;
 *  the caller (`report.ts`) decides what to do with a successful result. */
export function parseWorktreesCommand(prefix: string): TokenizeResult {
  const tokens = tokenize(prefix)
  if (tokens === null || tokens.length === 0) return { ok: false, kind: 'unparseable-command' }

  const [binary, ...args] = tokens
  if (binary !== 'node') return { ok: false, kind: 'unsupported-runner', token: binary ?? '' }

  return { ok: true, binary, args }
}

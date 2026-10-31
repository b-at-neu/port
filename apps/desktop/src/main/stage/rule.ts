// Pure proposed-rule and rule-validation logic for "Allow from now on" — no I/O, no Node builtin.

/** `Bash` proposes a two-token rule when the second token is a plain word; otherwise it narrows to the first token alone. Any other tool proposes its bare name. */
export function proposedRule(toolName: string, input: Readonly<Record<string, unknown>>): string {
  if (toolName !== 'Bash') return toolName
  const command = typeof input.command === 'string' ? input.command : ''
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0)
  const tok1 = tokens[0]
  const tok2 = tokens[1]
  if (tok1 === undefined) return 'Bash(*)'
  if (tok2 !== undefined && !/^[-./"']/.test(tok2)) return `Bash(${tok1} ${tok2} *)`
  return `Bash(${tok1} *)`
}

export type ValidateRuleResult = { readonly ok: true; readonly rule: string } | { readonly ok: false; readonly reason: string }

const DANGEROUS_CHARS = /[;&|`]|\$\(/

/** Refuses an empty rule, the unrestricted `Bash`/`Bash(*)`/`Bash( *)` forms, and any rule carrying a shell metacharacter that could smuggle a second command past the one it names. `alreadyPresent` lets a caller report a duplicate as its own, non-error outcome. */
export function validateRule(rule: string, alreadyPresent: readonly string[] = []): ValidateRuleResult {
  const trimmed = rule.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  if (trimmed === 'Bash' || trimmed === 'Bash(*)' || trimmed === 'Bash( *)') return { ok: false, reason: 'unrestricted' }
  if (DANGEROUS_CHARS.test(trimmed)) return { ok: false, reason: 'dangerous-characters' }
  if (alreadyPresent.includes(trimmed)) return { ok: false, reason: 'already-allowed' }
  return { ok: true, rule: trimmed }
}

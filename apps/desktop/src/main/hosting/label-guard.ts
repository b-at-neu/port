// Pure: recognises a Bash command that writes an issue or pull request label. No imports, like `stage-policy.ts`.

export const LABEL_GUARD_MESSAGE = "port moves pipeline labels itself. Don't edit labels — finish with your HANDBACK: line."

const LABEL_WRITE_FORMS: readonly { readonly form: string; readonly pattern: RegExp }[] = [
  { form: 'gh edit label flag', pattern: /\bgh\s+(?:issue|pr)\s+edit\b[^\n]*?--(?:add|remove)-label\b/ },
  { form: 'gh create --label', pattern: /\bgh\s+(?:issue|pr)\s+create\b[^\n]*?(?:^|\s)(?:--label\b|-l(?:\s|=|\S))/ },
  { form: 'gh api issues labels', pattern: /\bgh\s+api\b[^\n]*?\/issues\/\d+\/labels/ },
]

/** The form of label write a command contains, or `null` for a command that writes none — reading labels (`--json labels`) never matches. */
export function labelWriteOf(command: string): string | null {
  for (const { form, pattern } of LABEL_WRITE_FORMS) {
    if (pattern.test(command)) return form
  }
  return null
}

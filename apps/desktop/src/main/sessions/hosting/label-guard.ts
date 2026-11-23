// Pure: recognises a Bash command that writes an issue or pull request label, or an issue body. No imports, like `stage-policy.ts`.

export const LABEL_GUARD_MESSAGE = "port moves pipeline labels itself. Don't edit labels — finish with your HANDBACK: line."

export const ISSUE_BODY_GUARD_MESSAGE = 'port posts the plan itself. Write it to .temp/plan-<N>.md and finish with your HANDBACK: line.'

const ISSUE_EDIT_BODY = /\bgh\s+issue\s+edit\b[^\n]*?(?:^|\s)(?:--body(?:-file)?\b|-[bF])/
const API_ISSUE_PATH = /\bgh\s+api\b[^\n]*?\/issues\/\d+(?=[\s"'?]|$)/
const API_BODY_WRITE = /(?:^|\s)(?:(?:-X|--method)[\s=]+PATCH\b|--input\b)|\bbody=/i

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

/** Whether a command replaces an issue's body — `gh issue edit --body…`, or a `gh api` write to `/issues/<n>` itself. Comments, views and `gh pr edit` never match. */
export function issueBodyWriteOf(command: string): boolean {
  if (ISSUE_EDIT_BODY.test(command)) return true
  return API_ISSUE_PATH.test(command) && API_BODY_WRITE.test(command)
}

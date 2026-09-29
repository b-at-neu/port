// Every string the permission dialog renders lives here, one function per
// concern — a new tool kind or grant kind is a compile error rather than a
// silently blank line, the same rule `claim/copy.ts`'s own header states.
// Pure string functions; no DOM here.
import type { PendingPermission, SessionGrantItem } from '../../../shared/hosting/types'

export const DENY_MESSAGE_LABEL = 'Tell Claude why (optional)'
export const DENY_MESSAGE_PLACEHOLDER = 'Sent back to Claude with your denial.'
export const DENY_MESSAGE_MAXLENGTH = 2000

export const INPUT_UNRENDERABLE_MESSAGE = "This request's input can't be displayed, so it can only be denied."
export const IPC_FAILURE_MESSAGE = "Couldn't reach the main process — your answer wasn't sent. Try again."

export const DENY_LABEL = 'Deny'
export const ALLOW_ONCE_LABEL = 'Allow once'
export const ALLOW_SESSION_LABEL = 'Allow for this session'
export const SENDING_LABEL = 'Sending…'

/** `title` when the CLI supplied one, else "Claude wants to use
 *  <displayName ?? toolName>". */
export function headingText(permission: PendingPermission): string {
  if (permission.title !== null && permission.title !== '') return permission.title
  return `Claude wants to use ${permission.displayName ?? permission.toolName}`
}

/** `<repo> · <sessionKey>`, plus ` · subagent <agentId>` when a subagent
 *  asked, plus a `<index> of <total> waiting` counter once more than one
 *  request is queued across every hosted session. */
export function contextLine(repoLabel: string, sessionKey: string, agentId: string | null, index: number, total: number): string {
  const parts = [`${repoLabel} · ${sessionKey}`]
  if (agentId !== null) parts.push(`subagent ${agentId}`)
  if (total > 1) parts.push(`${String(index)} of ${String(total)} waiting`)
  return parts.join(' · ')
}

export function decisionReasonLine(decisionReason: string): string {
  return `Why you're being asked: ${decisionReason}`
}

export function blockedPathLine(blockedPath: string): string {
  return `Outside the allowed directories: ${blockedPath}`
}

const FILE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function stringField(input: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}

/** Picks the one field worth reading first, by tool — `null` for any other
 *  tool, or when the field is missing or not a string. */
export function primaryLine(toolName: string, input: Readonly<Record<string, unknown>>): string | null {
  if (toolName === 'Bash') return stringField(input, 'command')
  if (FILE_PATH_TOOLS.has(toolName)) return stringField(input, 'file_path') ?? stringField(input, 'notebook_path')
  if (toolName === 'WebFetch') return stringField(input, 'url')
  if (toolName === 'WebSearch') return stringField(input, 'query')
  if (toolName === 'Glob' || toolName === 'Grep') return stringField(input, 'pattern')
  return null
}

export type FormatInputResult = { readonly ok: true; readonly text: string } | { readonly ok: false }

/** The full input is never truncated — it scrolls instead, because the
 *  operator is approving exactly those bytes. `ok: false` only when
 *  `JSON.stringify` itself throws (a circular structure, which the SDK
 *  should never produce, but this dialog must never crash on it). */
export function formatInput(input: Readonly<Record<string, unknown>>): FormatInputResult {
  try {
    return { ok: true, text: JSON.stringify(input, null, 2) }
  } catch {
    return { ok: false }
  }
}

/** One line per `SessionGrantItem` kind — the plan's own **Grant lines**. */
export function grantLines(summary: readonly SessionGrantItem[]): readonly string[] {
  return summary.map((item) => {
    switch (item.kind) {
      case 'rule':
        return item.ruleContent !== null ? `${item.toolName}(${item.ruleContent})` : `${item.toolName} — every call`
      case 'directory':
        return `Access to ${item.path}`
      case 'accept-edits':
        return 'Every file edit'
    }
  })
}

/** The line under **Allow for this session** — "Also allows, until this
 *  session ends: <grantLines>". */
export function grantSummaryLine(summary: readonly SessionGrantItem[]): string {
  return `Also allows, until this session ends: ${grantLines(summary).join(', ')}`
}

/** `document.title` while the queue is non-empty — "Port" otherwise. A
 *  prompt waits with no deadline, so an unfocused window must still show
 *  that something is blocked. */
export function documentTitle(count: number): string {
  if (count === 0) return 'Port'
  return `Port — ${String(count)} permission request${count === 1 ? '' : 's'} waiting`
}

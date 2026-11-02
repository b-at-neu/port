// Every string the Board renders for a blocked ticket: the row tag, its tooltip and the item pane block.
import type { BlockedOnTag } from '@/types/board'
import { BACKLOG_BLOCKED_TOOLTIP_HEADING, backlogBlockerLine, backlogBlockerTruncatedCopy } from '@/renderer/backlog/copy'

export const BLOCKED_SECTION_HEADING = 'Blocked on'

export const BLOCKED_AGENT_SAYS = 'The agent says:'

export const BLOCKED_FROM_TICKET = 'From the ticket:'

export const BLOCKED_OPEN_COMMENT = 'Open comment'

export const BLOCKED_FALLBACK_COPY = 'An agent marked this blocked. Its reason is on the ticket.'

export const BLOCKED_DEPENDENCY_HEADING = BACKLOG_BLOCKED_TOOLTIP_HEADING

export function blockedTruncatedCopy(shown: number, total: number): string {
  return backlogBlockerTruncatedCopy(shown, total)
}

export function blockedDependencyLine(blocker: { readonly number: number; readonly title: string }): string {
  return backlogBlockerLine(blocker)
}

export function blockedUnreadableCopy(reason: string): string {
  return `Couldn't read this ticket's blocked-by links: ${reason}.`
}

/** The row tag's visible text. */
export function blockedTagLabel(tag: BlockedOnTag): string {
  switch (tag.kind) {
    case 'dependency': {
      const first = tag.open[0]
      const more = tag.open.length - 1
      return `Waiting on #${String(first?.number ?? 0)}${more > 0 ? ` +${String(more)}` : ''}`
    }
    case 'session':
    case 'comment':
      return tag.text
    case 'unreadable':
      return 'Blockers unknown'
    case 'fallback':
      return 'Reason on ticket'
  }
}

/** The tag's tooltip and accessible name, as one string; a dependency tag's tooltip also lists each blocker. */
export function blockedTagSummary(tag: BlockedOnTag): string {
  switch (tag.kind) {
    case 'dependency':
      return `${BLOCKED_DEPENDENCY_HEADING} ${tag.open.map(blockedDependencyLine).join(', ')}`
    case 'session':
    case 'comment':
      return `Blocked: ${tag.text}`
    case 'unreadable':
      return blockedUnreadableCopy(tag.reason)
    case 'fallback':
      return BLOCKED_FALLBACK_COPY
  }
}

export function blockerSentToast(number: number | null): string {
  return `Sent your answer to ${number !== null ? `#${String(number)}'s` : 'the'} agent. It clears "Blocked" itself and carries on.`
}

export function blockerSendError(error: 'unknown-session' | 'blocked-command' | 'unreachable', number: number | null): string {
  if (error === 'unreachable') return "Couldn't reach the main process. Nothing was sent."
  if (error === 'blocked-command') return "That text is a command the session can't run here. Reword your answer."
  return `That session has ended. Unblock ${number !== null ? `#${String(number)}` : 'the item'} from its row once the board catches up.`
}

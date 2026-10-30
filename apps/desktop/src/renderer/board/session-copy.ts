// Copy for the item pane's session links. Pure string functions; no DOM here.
import type { TicketSessionLink } from '@/types/board'
import type { StageAgent } from '@/types/tick'
import { formatAgo } from '@/renderer/lib/relative-time'
import { formatCost } from '@/utils/hosting/usage'

const SESSION_LINK_NAME: Readonly<Record<StageAgent, string>> = { plan: 'Plan agent', impl: 'Implement agent', review: 'Review agent', revise: 'Revise agent' }

/** A session link's own name: its agent, or `Your session`. */
export function sessionLinkName(who: TicketSessionLink['who']): string {
  return who.kind === 'stage' ? SESSION_LINK_NAME[who.agent] : 'Your session'
}

function agoSince(iso: string, now: Date): string {
  return formatAgo(now.getTime() - Date.parse(iso))
}

function stateSegment(link: TicketSessionLink, now: Date): string {
  switch (link.state) {
    case 'live':
      return `Live · started ${agoSince(link.at, now)}`
    case 'ended':
      return `Ended ${agoSince(link.endedAt ?? link.at, now)}`
    case 'started':
      return `Started ${agoSince(link.at, now)}`
    case 'seen':
      return `Last active ${agoSince(link.at, now)}`
  }
}

/** `Live · started 12m ago · $0.42`, `Ended 2h ago · $1.18`, `Started 3h ago`, `Last active 2h ago` — the cost segment is omitted when unknown, never `$0.00`. */
export function sessionLinkMeta(link: TicketSessionLink, now: Date): string {
  const segments = [stateSegment(link, now)]
  if (link.costUsd !== null) segments.push(formatCost(link.costUsd))
  if (link.operatorJoined) segments.push('you joined')
  return segments.join(' · ')
}

export function yourSessionsLabel(): string {
  return 'Your sessions'
}

export function sessionLinkAccessibleName(link: TicketSessionLink, now: Date): string {
  return `Open ${sessionLinkName(link.who)}, ${sessionLinkMeta(link, now)}`
}

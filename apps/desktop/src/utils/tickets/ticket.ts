// Folds a repository's items into tickets: one per issue, its linked open pull request riding along. Pure and renderer-safe.
import type { ReconciledItem } from '@/types/state'
import type { Ticket, TicketIndex, TicketRef } from '@/types/ticket'

/** The pull request when it carries a stage label, else the issue when it does, else whichever exists — both unlabelled leaves the stranded pull request as the honest Unstaged. */
function primaryOf(issue: ReconciledItem, pullRequest: ReconciledItem | null): ReconciledItem {
  if (pullRequest !== null && (pullRequest.stage !== null || issue.stage === null)) return pullRequest
  return issue
}

function issueRef(issue: ReconciledItem, pullRequest: ReconciledItem | null): TicketRef {
  return { kind: 'issue', number: issue.number, title: issue.title, url: issue.url, pullRequest: pullRequest === null ? null : { number: pullRequest.number, url: pullRequest.url } }
}

function unlinkedRef(pullRequest: ReconciledItem): TicketRef {
  return { kind: 'unlinked-pr', number: pullRequest.number, title: pullRequest.title, url: pullRequest.url }
}

export function ticketIndex(items: readonly ReconciledItem[]): TicketIndex {
  const pullRequests = new Map(items.filter((item) => item.kind === 'pull-request').map((item) => [item.number, item] as const))
  const issues = items.filter((item) => item.kind === 'issue')
  const issueNumbers = new Set(issues.map((issue) => issue.number))
  const folded = new Set<number>()
  const tickets: Ticket[] = []
  const byNumber = new Map<number, Ticket>()

  function add(ticket: Ticket): void {
    tickets.push(ticket)
    byNumber.set(ticket.ref.number, ticket)
    if (ticket.pullRequest !== null) byNumber.set(ticket.pullRequest.number, ticket)
  }

  for (const issue of issues) {
    const pullRequest = issue.linked === null ? null : (pullRequests.get(issue.linked) ?? null)
    if (pullRequest !== null) folded.add(pullRequest.number)
    add({ ref: issueRef(issue, pullRequest), issue, pullRequest, primary: primaryOf(issue, pullRequest) })
  }

  for (const pullRequest of pullRequests.values()) {
    if (folded.has(pullRequest.number)) continue
    const linkedIssue = pullRequest.linked
    const claimable = linkedIssue !== null && !issueNumbers.has(linkedIssue) && !byNumber.has(linkedIssue)
    const ref: TicketRef = claimable
      ? { kind: 'issue', number: linkedIssue, title: pullRequest.title, url: pullRequest.url, pullRequest: { number: pullRequest.number, url: pullRequest.url } }
      : unlinkedRef(pullRequest)
    add({ ref, issue: null, pullRequest, primary: pullRequest })
  }

  return { tickets, byNumber }
}

/** `#<n> <title>`, or `PR#<n> <title>` for a pull request with no ticket. */
export function ticketLabel(ref: TicketRef): string {
  return `${ref.kind === 'issue' ? '#' : 'PR#'}${String(ref.number)} ${ref.title}`
}

/** The label of the ticket a number resolves to; a number outside the sweep falls back to its bare `#<n>` or `PR#<n>`. */
export function ticketLabelFor(index: TicketIndex, number: number, kind: ReconciledItem['kind']): string {
  const ticket = index.byNumber.get(number)
  return ticket !== undefined ? ticketLabel(ticket.ref) : `${kind === 'issue' ? '#' : 'PR#'}${String(number)}`
}

/** `(PR#<n>)` for a ticket with a linked pull request, `null` otherwise. */
export function prSuffixOf(ref: TicketRef): string | null {
  return ref.kind === 'issue' && ref.pullRequest !== null ? `(PR#${String(ref.pullRequest.number)})` : null
}

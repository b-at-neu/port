import type { ReconciledItem } from '@/types/state'

/** What a ticket is called everywhere: its issue, with any linked open pull request as secondary text, or a bare pull request that closes nothing. */
export type TicketRef =
  | { readonly kind: 'issue'; readonly number: number; readonly title: string; readonly url: string; readonly pullRequest: { readonly number: number; readonly url: string } | null }
  | { readonly kind: 'unlinked-pr'; readonly number: number; readonly title: string; readonly url: string }

export interface Ticket {
  readonly ref: TicketRef
  readonly issue: ReconciledItem | null
  readonly pullRequest: ReconciledItem | null
  /** The item whose labels drive the ticket's status and actions. */
  readonly primary: ReconciledItem
}

export interface TicketIndex {
  readonly tickets: readonly Ticket[]
  /** Holds both the issue number and the pull request number of a folded ticket. */
  readonly byNumber: ReadonlyMap<number, Ticket>
}

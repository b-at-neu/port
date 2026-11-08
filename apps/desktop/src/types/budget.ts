// The cost ledger's own shapes, shared by the pure ledger module, its GitHub store, and the gate.

/** One line of a ticket's `## Pipeline Cost` comment. */
export interface LedgerRow {
  readonly stage: string
  readonly model: string
  readonly startedAt: string
  readonly seconds: number
  readonly outcome: string
}

/** One dispatch in the local session log: `open` until its stage ends, `pending` until flushed to the ledger, then `closed`. */
export interface SessionRow {
  readonly issue: number
  readonly dispatchNumber: number
  readonly stage: string
  readonly model: string
  readonly startedAt: string
  readonly state: 'open' | 'pending' | 'closed'
  readonly seconds: number
  readonly outcome: string
}

/** What one flush leaves a ticket at — the ledger is cumulative, so the last write wins. */
export interface TicketTotal {
  readonly issue: number
  readonly secondsUsed: number
  readonly ceilingSeconds: number | null
}

export type CeilingResult = { readonly ok: true; readonly ceilingSeconds: number | null } | { readonly ok: false; readonly offending: string }

export type LedgerRead = { readonly ok: true; readonly rows: readonly LedgerRow[]; readonly seconds: number; readonly ref: number | null } | { readonly ok: false; readonly why: string }

export type LedgerWrite = { readonly ok: true } | { readonly ok: false; readonly error: string }

export type IssueForPr = { readonly ok: true; readonly issue: number } | { readonly ok: false; readonly why: string }

export interface LedgerReader {
  readonly readLedger: (params: { readonly owner: string; readonly name: string; readonly issue: number }) => Promise<LedgerRead>
  readonly issueForPr: (params: { readonly repo: string; readonly pr: number }) => Promise<IssueForPr>
}

/** `ref` is the existing comment's id, or `null` to open a new one. */
export type LedgerWriter = (params: { readonly repo: string; readonly issue: number; readonly ref: number | null; readonly body: string }) => Promise<LedgerWrite>

/** `allow`/`exceeded` only: `hold` is a caller-level state for an unreadable ledger, never a computed one. */
export type ComputedVerdict = 'allow' | 'exceeded'

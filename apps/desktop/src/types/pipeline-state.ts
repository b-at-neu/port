// Contract for the app-owned pipeline state store: plain JSON, safe to cross the state worker boundary.
import type { ReadyEntry } from '@/types/actions'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { PipelineItemKind } from '@/types/github'
import type { RepositoryState } from '@/types/state'
import type { RunState } from '@/types/dispatch'
import type { FileResult } from '@/types/platform'
import type { RunChange, TicketEvent } from '@/types/stage-labels'
import type { WriteOutcome } from '@/types/writes'
import type { Run, Ticket } from '@/utils/pipeline/ticket'

export interface StoredHistoryRow {
  readonly at: string
  readonly action: string
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly actor: string | null
}

/** The last label mirror write that did not land, kept until a retry does. */
export interface MirrorFailure {
  readonly at: string
  readonly outcome: WriteOutcome
}

/** `keys` holds the role-bearing stage keys; `marked` and `autoPlan` carry the two marker keys. */
export interface StoredItem {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly keys: readonly LabelKey[]
  readonly marked: boolean
  readonly autoPlan: boolean
  readonly claimedAt: string | null
  readonly reviewCycles: number
  readonly history: readonly StoredHistoryRow[]
  readonly updatedAt: string
  /** A pull request's ticket, `null` for an issue or an unlinked pull request. */
  readonly issue: number | null
  readonly mirrorFailure: MirrorFailure | null
}

export interface RepoRecord {
  readonly seededAt: string
  /** Keyed by `String(ticket.ticket)`. */
  readonly tickets: Readonly<Record<string, Ticket>>
}

/** One repository's operator run state: `dispatching`, `draining` or `paused`. */
export interface DispatchEntry {
  readonly state: RunState
  readonly since: string | null
}

export interface PipelineStateFile {
  readonly version: 3
  /** Keyed by repository id; a repository with no entry reads paused. */
  readonly dispatch: Readonly<Record<string, DispatchEntry>>
  readonly repositories: Readonly<Record<string, RepoRecord>>
}

/** What the file is: readable, or empty because it could not be read, in which case `run` and `drain` are refused until a write lands. */
export type PipelineStateStatus = { readonly kind: 'loaded' } | { readonly kind: 'unreadable'; readonly message: string; readonly path: string }

/** A completed hand-back whose label write never landed before the app stopped. */
export interface UnsettledRun {
  readonly ticket: Ticket
  readonly run: Run
}


/** Every stored key, markers included. */
export function fullKeysOf(item: Pick<StoredItem, 'keys' | 'marked' | 'autoPlan'>): readonly LabelKey[] {
  return [...(item.marked ? (['marker'] as const) : []), ...(item.autoPlan ? (['autoPlan'] as const) : []), ...item.keys]
}

/** `unseeded` means the repository has no record yet and reseeds once from labels; `store` means the stored items decide stage. */
export type PipelineView = { readonly kind: 'unseeded' } | { readonly kind: 'store'; readonly items: readonly StoredItem[] }

/** One mirror write with no transition: whatever the store holds for the ticket. */
export interface MirrorItemParams {
  readonly entry: ReadyEntry
  readonly ref: TicketRef
  readonly action: string
  readonly auditDir: string
}

/** One half of a ticket: its issue, or its pull request. */
export interface TicketRef {
  readonly kind: PipelineItemKind
  readonly number: number
}

/** A tracked item and the full key set (markers included) it carries in the store. */
export interface TrackedRef {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly keys: readonly LabelKey[]
}

export interface PipelineStateStore {
  /** Settles once the file has been read; every read and transition waits on it. */
  readonly ready: Promise<void>
  readonly view: (repoId: RepoId) => PipelineView
  readonly tracked: (repoId: RepoId) => readonly TrackedRef[] | null
  /** The ticket a half belongs to, `null` when the repository is unseeded or the half is unknown. */
  readonly ticket: (repoId: RepoId, ref: TicketRef) => Ticket | null
  /** Every ticket the repository holds, `null` while it is unseeded. */
  readonly tickets: (repoId: RepoId) => readonly Ticket[] | null
  readonly seed: (repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>) => Promise<void>
  readonly prune: (repoId: RepoId, closed: readonly number[]) => Promise<void>
  readonly recordMirror: (repoId: RepoId, ref: TicketRef, failure: MirrorFailure | null) => Promise<void>
  /** Runs the table on the ticket `ref` names and persists the result; `expectedRev` `null` skips the concurrency check. */
  readonly apply: (repoId: RepoId, ref: TicketRef, event: TicketEvent, expectedRev: number | null) => Promise<StoreApplyResult>
  readonly status: () => PipelineStateStatus
  /** Every ticket of every repository. */
  readonly allTickets: () => readonly Ticket[]
  /** Appends a run to the ticket its `item` names. */
  readonly startRun: (repoId: RepoId, run: Run) => Promise<StoreApplyResult>
  /** Applies one change to a run on whichever ticket holds it. */
  readonly applyRun: (repoId: RepoId, runId: string, change: RunChange) => Promise<StoreApplyResult>
  /** Marks every open run `quit` in one write. */
  readonly quitRuns: () => Promise<void>
  /** The hand-backs the last boot found unwritten, once: a second call for the same repository is empty. */
  readonly takeReplays: (repoId: RepoId) => readonly UnsettledRun[]
  readonly runStates: () => Readonly<Record<string, DispatchEntry>>
  readonly writeRunStates: (next: Readonly<Record<string, DispatchEntry>>) => Promise<FileResult<void>>
}

export type StoreApplyResult =
  | { readonly ok: true; readonly ticket: Ticket; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'moved' | 'unknown-handback' | 'stale' | 'unseeded' }
  | { readonly ok: false; readonly reason: 'persist-failed'; readonly message: string }

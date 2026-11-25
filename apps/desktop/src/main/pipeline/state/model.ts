// Pure: no I/O. The store file's validation, seeding, pruning and the legacy views of its tickets.
import { isOpen } from '@/main/pipeline/runs'
import { ticketsOfItems } from '@/main/pipeline/state/migrate'
import { itemsOf } from '@/main/pipeline/state/mirror'
import { RUN_STATES } from '@/types/dispatch'
import { fullKeysOf, type DispatchEntry, type MirrorFailure, type PipelineStateFile, type PipelineView, type RepoRecord, type StoredHistoryRow, type StoredItem, type TicketRef, type TrackedRef } from '@/types/pipeline-state'
import type { RepositoryState } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { ticketSchema, type Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

export const FILE_VERSION = 3

const HISTORY_ROWS = 50
const IN_FLIGHT: ReadonlySet<LabelKey> = new Set(LABEL_DEFAULTS.filter((label) => label.role === 'in-flight').map((label) => label.key))

export function emptyFile(): PipelineStateFile {
  return { version: FILE_VERSION, dispatch: {}, repositories: {} }
}

function dispatchOf(value: unknown): Record<string, DispatchEntry> {
  const entries: Record<string, DispatchEntry> = {}
  if (!isRecord(value)) return entries
  for (const [repoId, raw] of Object.entries(value)) {
    const state = isRecord(raw) ? RUN_STATES.find((candidate) => candidate === raw.state) : undefined
    if (isRecord(raw) && state !== undefined) entries[repoId] = { state, since: typeof raw.since === 'string' ? raw.since : null }
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(repoId: string, value: unknown): RepoRecord | null {
  if (!isRecord(value) || typeof value.seededAt !== 'string' || !isRecord(value.tickets)) return null
  const tickets: Record<string, Ticket> = {}
  for (const [key, raw] of Object.entries(value.tickets)) {
    const parsed = ticketSchema.safeParse(raw)
    if (parsed.success) tickets[String(parsed.data.ticket)] = parsed.data
    else console.error(`[pipeline-state] dropped ticket ${key} of ${repoId}: ${parsed.error.message}`)
  }
  return { seededAt: value.seededAt, tickets }
}

/** A missing, malformed or newer-version file is empty; a bad ticket is dropped, never its repository. */
export function parseFile(value: unknown): PipelineStateFile {
  if (!isRecord(value) || value.version !== FILE_VERSION || !isRecord(value.repositories)) return emptyFile()
  const repositories: Record<string, RepoRecord> = {}
  for (const [repoId, raw] of Object.entries(value.repositories)) {
    const record = recordOf(repoId, raw)
    if (record !== null) repositories[repoId] = record
  }
  return { version: FILE_VERSION, dispatch: dispatchOf(value.dispatch), repositories }
}

/** One ticket per reconciled change, from what the board just showed. */
export function seedFrom(repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>, at: string): RepoRecord {
  const items: StoredItem[] = state.items.map((item) => ({
    kind: item.kind,
    number: item.number,
    keys: item.matchedKeys.filter((key) => key !== 'marker' && key !== 'autoPlan'),
    marked: item.matchedKeys.includes('marker'),
    autoPlan: item.matchedKeys.includes('autoPlan'),
    claimedAt: item.stageHistory.findLast((entry) => IN_FLIGHT.has(entry.key))?.at ?? null,
    reviewCycles: item.reviewCycleCount ?? 0,
    history: item.stageHistory.map((entry): StoredHistoryRow => ({ at: entry.at, action: 'seed', add: [entry.key], remove: [], actor: entry.actor })).slice(-HISTORY_ROWS),
    updatedAt: at,
    issue: item.kind === 'pull-request' ? item.linked : null,
    mirrorFailure: null,
  }))
  const tickets = ticketsOfItems(repoId, items, 'seed')
  return { seededAt: at, tickets: Object.fromEntries(tickets.map((ticket) => [String(ticket.ticket), ticket])) }
}

/** The ticket a half belongs to: an issue by its number, a pull request by its own or, while new, by the issue its branch names. */
export function ticketFor(record: RepoRecord, ref: TicketRef, issue: number | null): Ticket | null {
  const tickets = Object.values(record.tickets)
  if (ref.kind === 'issue') return tickets.find((ticket) => ticket.ticket === ref.number && ticket.pr?.number !== ref.number) ?? null
  const owned = tickets.find((ticket) => ticket.pr?.number === ref.number)
  if (owned !== undefined || issue === null) return owned ?? null
  const named = record.tickets[String(issue)]
  return named !== undefined && named.pr === null ? named : null
}

export function withTicket(record: RepoRecord, ticket: Ticket): RepoRecord {
  return { ...record, tickets: { ...record.tickets, [String(ticket.ticket)]: ticket } }
}

// A repeated failure keeps its first instant, so a retry that fails the same way is not a new event.
function failureKeyOf(outcome: WriteOutcome): string {
  return outcome.kind === 'write-failed' ? `write-failed|${outcome.classification}|${outcome.stderr}` : JSON.stringify(outcome)
}

/** The record unchanged when the ticket is missing or already holds this failure. */
export function recordMirror(record: RepoRecord, ref: TicketRef, failure: MirrorFailure | null): RepoRecord {
  const existing = ticketFor(record, ref, null)
  if (existing === null) return record
  const held = existing.mirror.failure
  const same = held === failure || (held !== null && failure !== null && failureKeyOf(held.outcome) === failureKeyOf(failure.outcome))
  return same ? record : withTicket(record, { ...existing, mirror: { ...existing.mirror, failure } })
}

/** Drops a ticket whose pull request is closed, or whose issue is closed when it has none, which keeps the tracked list bounded. A ticket with an open or interrupted run stays, so a kept worktree is never orphaned. */
export function prune(record: RepoRecord, closed: readonly number[]): RepoRecord {
  if (closed.length === 0) return record
  const gone = new Set(closed)
  const tickets = Object.fromEntries(Object.entries(record.tickets).filter(([, ticket]) => !gone.has(ticket.pr?.number ?? ticket.ticket) || ticket.runs.some((run) => isOpen(run) || run.interruption !== null)))
  return Object.keys(tickets).length === Object.keys(record.tickets).length ? record : { ...record, tickets }
}

/** A repository the store does not hold is unseeded and reseeds once from labels. */
export function viewOf(record: RepoRecord | undefined): PipelineView {
  if (record === undefined) return { kind: 'unseeded' }
  return { kind: 'store', items: Object.values(record.tickets).flatMap(itemsOf) }
}

export function trackedOf(record: RepoRecord | undefined): readonly TrackedRef[] | null {
  if (record === undefined) return null
  return Object.values(record.tickets)
    .flatMap(itemsOf)
    .map((item) => ({ kind: item.kind, number: item.number, keys: fullKeysOf(item) }))
}

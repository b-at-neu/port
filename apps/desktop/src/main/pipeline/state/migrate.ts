// Pure: version 1 pipeline state, and the one rule that turns label keys into a ticket. Migration, label seeding and the `labels` event all use it.
import type { MirrorFailure, StoredHistoryRow, StoredItem } from '@/types/pipeline-state'
import { LABEL_KEYS, type LabelKey } from '@/utils/labels/vocabulary'
import { mirrorFailureSchema, V1_KEY_MEANING, type Event, type Stage, type Status, type Ticket, type V1KeyMeaning } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

/** Two version-1 halves of 50 rows each. */
export const HISTORY_CAP = 100

const KEYS: ReadonlySet<string> = new Set(LABEL_KEYS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keysOf(value: unknown): LabelKey[] | null {
  if (!Array.isArray(value)) return null
  return value.every((entry): entry is LabelKey => typeof entry === 'string' && KEYS.has(entry)) ? [...value] : null
}

function rowOf(value: unknown): StoredHistoryRow | null {
  if (!isRecord(value)) return null
  const add = keysOf(value.add)
  const remove = keysOf(value.remove)
  if (typeof value.at !== 'string' || typeof value.action !== 'string' || add === null || remove === null) return null
  if (value.actor !== null && typeof value.actor !== 'string') return null
  return { at: value.at, action: value.action, add, remove, actor: value.actor }
}

/** A failure whose outcome kind is unknown is dropped, never the item. */
function mirrorFailureOf(value: unknown): MirrorFailure | null {
  const parsed = mirrorFailureSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function itemOf(value: unknown): StoredItem | null {
  if (!isRecord(value)) return null
  if (value.kind !== 'issue' && value.kind !== 'pull-request') return null
  const keys = keysOf(value.keys)
  if (keys === null || !Array.isArray(value.history)) return null
  if (typeof value.number !== 'number' || !Number.isSafeInteger(value.number)) return null
  if (typeof value.marked !== 'boolean' || typeof value.autoPlan !== 'boolean') return null
  if (typeof value.reviewCycles !== 'number' || typeof value.updatedAt !== 'string') return null
  if (value.claimedAt !== null && typeof value.claimedAt !== 'string') return null
  return {
    kind: value.kind,
    number: value.number,
    keys,
    marked: value.marked,
    autoPlan: value.autoPlan,
    claimedAt: value.claimedAt,
    reviewCycles: value.reviewCycles,
    history: value.history.map(rowOf).filter((row): row is StoredHistoryRow => row !== null),
    updatedAt: value.updatedAt,
    issue: typeof value.issue === 'number' && Number.isSafeInteger(value.issue) ? value.issue : null,
    mirrorFailure: mirrorFailureOf(value.mirrorFailure),
  }
}

interface V1Record {
  readonly seededAt: string
  readonly items: readonly StoredItem[]
}

function recordOf(value: unknown): V1Record | null {
  if (!isRecord(value) || typeof value.seededAt !== 'string' || !isRecord(value.items)) return null
  // A record carrying any other non-null field was frozen while the terminal cockpit held it, so it reseeds once from labels.
  if (Object.entries(value).some(([key, field]) => key !== 'seededAt' && key !== 'items' && field !== null)) return null
  return { seededAt: value.seededAt, items: Object.values(value.items).flatMap((raw) => itemOf(raw) ?? []) }
}

function stateOf(key: LabelKey, at: string): { readonly stage: Stage; readonly status: Status } | null {
  const meaning: V1KeyMeaning = V1_KEY_MEANING[key]
  if (meaning.kind !== 'state') return null
  switch (meaning.status) {
    case 'queued':
      return { stage: meaning.stage, status: { kind: 'queued', reason: meaning.reason ?? 'new', since: at } }
    case 'running':
      return { stage: meaning.stage, status: { kind: 'running', runId: null } }
    case 'waiting-on-you':
      return { stage: meaning.stage, status: { kind: 'waiting-on-you', gate: meaning.gate ?? 'escalation', detail: '' } }
    case 'blocked':
      return { stage: meaning.stage, status: { kind: 'blocked', on: [], reason: '' } }
    case 'held':
      return { stage: meaning.stage, status: { kind: 'held', on: 'paused', detail: 'stopped' } }
    case 'done':
      return { stage: meaning.stage, status: { kind: 'done', at } }
  }
}

interface HalfState {
  /** `null` when only `needsHuman` names the state, so the stage has to come from elsewhere. */
  readonly stage: Stage | null
  readonly status: Status
  readonly dropped: readonly LabelKey[]
}

const escalation = (): Status => ({ kind: 'waiting-on-you', gate: 'escalation', detail: '' })

function prefixed(half: 'issue' | 'pull-request', keys: readonly LabelKey[]): string[] {
  return keys.map((key) => `${half}:${key}`)
}

/** In-flight beats `needsHuman`, which beats any other gate, which beats a trigger; the keys that lose are dropped. */
function resolveHalf(keys: readonly LabelKey[], at: string): HalfState | null {
  const candidates = keys.flatMap((key) => {
    const state = key === 'approved' ? null : stateOf(key, at)
    return state === null ? [] : [{ key, ...state }]
  })
  const escalated = keys.includes('needsHuman')
  const [first] = candidates
  if (first === undefined) {
    if (escalated) return { stage: null, status: escalation(), dropped: [] }
    return keys.includes('approved') ? { stage: 'merge', status: { kind: 'waiting-on-you', gate: 'merge', detail: '' }, dropped: [] } : null
  }
  const dropped = (kept: LabelKey): LabelKey[] => candidates.map((candidate) => candidate.key).filter((key) => key !== kept)
  const running = candidates.find((candidate) => candidate.status.kind === 'running')
  if (running !== undefined) return { stage: running.stage, status: running.status, dropped: [...dropped(running.key), ...(escalated ? (['needsHuman'] as const) : [])] }
  if (escalated) return { stage: first.stage, status: escalation(), dropped: candidates.map((candidate) => candidate.key) }
  const gate = candidates.find((candidate) => candidate.status.kind !== 'queued') ?? first
  return { stage: gate.stage, status: gate.status, dropped: dropped(gate.key) }
}

export interface TicketOfKeysParams {
  readonly repo: RepoId
  readonly ticket: number
  /** The issue half's keys; empty when that half is not tracked. */
  readonly issueKeys: readonly LabelKey[]
  readonly pr: { readonly number: number; readonly keys: readonly LabelKey[]; readonly approvedAt: string | null } | null
  readonly history: readonly Event[]
  readonly at: string
  readonly mirrorFailure: MirrorFailure | null
  readonly reviewCycles: number
  /** The stage a state with no key of its own (`needsHuman` alone, or none) belongs to. */
  readonly stageHint: Stage | null
}

/** The ticket these keys stand for, and the prefixed keys that could not be kept. */
export function ticketOfKeys(params: TicketOfKeysParams): { readonly ticket: Ticket; readonly dropped: readonly string[] } {
  const { issueKeys, pr, at } = params
  const prState = pr === null ? null : resolveHalf(pr.keys, at)
  const issueState = resolveHalf(issueKeys, at)
  const chosen = prState ?? issueState
  const issueLosers = issueKeys.filter((key) => key === 'needsHuman' || stateOf(key, at) !== null)
  const dropped = prState === null ? prefixed('issue', issueState?.dropped ?? []) : [...prefixed('pull-request', prState.dropped), ...prefixed('issue', issueLosers)]
  const fallback: Stage = params.stageHint ?? (pr === null ? 'plan' : 'review')
  const stage = chosen === null ? fallback : (chosen.stage ?? fallback)
  const status: Status = chosen === null ? { kind: 'held', on: 'paused', detail: 'stopped' } : chosen.status
  const approved = pr?.keys.includes('approved') === true
  const ticket: Ticket = {
    rev: 0,
    repo: params.repo,
    ticket: params.ticket,
    pr: pr === null ? null : { number: pr.number, approvedAt: approved ? (pr.approvedAt ?? at) : null },
    stage,
    status,
    autoPlan: issueKeys.includes('autoPlan') || (pr?.keys.includes('autoPlan') ?? false),
    reviewCycles: params.reviewCycles,
    runs: [],
    history: params.history.slice(-HISTORY_CAP),
    mirror: { written: [], failure: params.mirrorFailure },
  }
  return { ticket, dropped }
}

/** The stage of the newest row that added a state key. */
function stageOfRows(rows: readonly StoredHistoryRow[]): Stage | null {
  for (const row of [...rows].sort((a, b) => a.at.localeCompare(b.at)).reverse()) {
    for (const key of row.add) {
      const meaning: V1KeyMeaning = V1_KEY_MEANING[key]
      if (meaning.kind === 'state') return meaning.stage
    }
  }
  return null
}

function eventsOf(item: StoredItem): Event[] {
  return item.history.map((row) => ({ at: row.at, action: row.action, actor: row.actor, to: null, legacy: { add: prefixed(item.kind, row.add), remove: prefixed(item.kind, row.remove) } }))
}

function fullKeysOf(item: StoredItem): LabelKey[] {
  return [...(item.marked ? (['marker'] as const) : []), ...(item.autoPlan ? (['autoPlan'] as const) : []), ...item.keys]
}

function newer(a: StoredItem, b: StoredItem): StoredItem {
  const delta = Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
  return delta === 0 ? (a.number > b.number ? a : b) : delta > 0 ? a : b
}

interface Group {
  readonly ticket: number
  issue: StoredItem | null
  pr: StoredItem | null
}

/** A pull request joins the ticket its `issue` names; a second pull request on one ticket keeps the newer, and the older stands alone. */
function groupsOf(items: readonly StoredItem[]): Group[] {
  const groups = new Map<number, Group>()
  const groupFor = (ticket: number): Group => {
    const existing = groups.get(ticket)
    if (existing !== undefined) return existing
    const created: Group = { ticket, issue: null, pr: null }
    groups.set(ticket, created)
    return created
  }
  for (const item of items.filter((candidate) => candidate.kind === 'issue')) groupFor(item.number).issue = item
  for (const pr of items.filter((candidate) => candidate.kind === 'pull-request')) {
    const group = groupFor(pr.issue ?? pr.number)
    if (group.pr === null) {
      group.pr = pr
      continue
    }
    const [kept, loser] = newer(group.pr, pr) === pr ? [pr, group.pr] : [group.pr, pr]
    group.pr = kept
    groupFor(loser.number).pr = loser
  }
  return [...groups.values()]
}

/** Groups version-1 items into tickets; `action` names the one event that records keys the table could not keep. */
export function ticketsOfItems(repo: RepoId, items: readonly StoredItem[], action: string): Ticket[] {
  return groupsOf(items).map((group) => {
    const halves = [group.issue, group.pr].flatMap((half) => half ?? [])
    const at = halves.map((half) => half.updatedAt).reduce((latest, candidate) => (candidate > latest ? candidate : latest))
    const history = halves.flatMap(eventsOf).sort((a, b) => a.at.localeCompare(b.at))
    const failures = halves.flatMap((half) => half.mirrorFailure ?? []).sort((a, b) => b.at.localeCompare(a.at))
    const { pr } = group
    const { ticket, dropped } = ticketOfKeys({
      repo,
      ticket: group.ticket,
      issueKeys: group.issue === null ? [] : fullKeysOf(group.issue),
      pr: pr === null ? null : { number: pr.number, keys: fullKeysOf(pr), approvedAt: null },
      history,
      at,
      mirrorFailure: failures[0] ?? null,
      reviewCycles: Math.max(0, ...halves.map((half) => half.reviewCycles)),
      stageHint: stageOfRows(halves.flatMap((half) => half.history)),
    })
    if (dropped.length === 0) return ticket
    return { ...ticket, history: [...ticket.history, { at, action, actor: null, to: null, legacy: { add: [], remove: [...dropped] } }].slice(-HISTORY_CAP) }
  })
}

/** The version-2 file, from a version-1 one. Any other version throws, which `createJsonStore` maps to unreadable. */
export function migrate(fromVersion: number, raw: unknown): unknown {
  if (fromVersion !== 1 || !isRecord(raw) || !isRecord(raw.repositories)) throw new Error(`no migration from pipeline state version ${String(fromVersion)}`)
  const repositories: Record<string, { seededAt: string; tickets: Record<string, Ticket> }> = {}
  for (const [repoId, value] of Object.entries(raw.repositories)) {
    const record = recordOf(value)
    if (record === null) continue
    const tickets = ticketsOfItems(repoId as RepoId, record.items, 'migrate-v1')
    repositories[repoId] = { seededAt: record.seededAt, tickets: Object.fromEntries(tickets.map((ticket) => [String(ticket.ticket), ticket])) }
  }
  return { version: 2, repositories }
}

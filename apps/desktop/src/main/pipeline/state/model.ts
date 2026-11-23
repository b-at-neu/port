// Pure: no I/O. The store file's validation, seeding, transitions and views.
import { HANDBACK_TOKENS } from '@/main/pipeline/transitions'
import type { PipelineItemKind } from '@/types/github'
import { fullKeysOf, type MirrorFailure, type PipelineStateFile, type PipelineView, type RepoRecord, type StoredHistoryRow, type StoredItem, type TrackedRef, type TransitionInput, type TransitionResult } from '@/types/pipeline-state'
import type { RepositoryState } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { LABEL_KEYS, type LabelKey } from '@/utils/labels/vocabulary'

export const FILE_VERSION = 1
export const HISTORY_CAP = 50

// A review hand-back that is a verdict on the head ends one review cycle; the other tokens re-queue the same head.
const NON_VERDICT_TOKENS: readonly string[] = ['rebase-required', 'head-moved']
const CYCLE_ACTIONS: ReadonlySet<string> = new Set(HANDBACK_TOKENS.review.filter((token) => !NON_VERDICT_TOKENS.includes(token)).map((token) => `stage-handback-${token}`))

const KEYS: ReadonlySet<string> = new Set(LABEL_KEYS)
const IN_FLIGHT: ReadonlySet<LabelKey> = new Set(LABEL_DEFAULTS.filter((label) => label.role === 'in-flight').map((label) => label.key))

export function emptyFile(): PipelineStateFile {
  return { version: FILE_VERSION, repositories: {} }
}

export function itemKey(kind: PipelineItemKind, number: number): string {
  return `${kind}:${String(number)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKey(value: unknown): value is LabelKey {
  return typeof value === 'string' && KEYS.has(value)
}

function keysOf(value: unknown): LabelKey[] | null {
  if (!Array.isArray(value)) return null
  return value.every(isKey) ? [...value] : null
}

function rowOf(value: unknown): StoredHistoryRow | null {
  if (!isRecord(value)) return null
  const add = keysOf(value.add)
  const remove = keysOf(value.remove)
  if (typeof value.at !== 'string' || typeof value.action !== 'string' || add === null || remove === null) return null
  if (value.actor !== null && typeof value.actor !== 'string') return null
  return { at: value.at, action: value.action, add, remove, actor: value.actor }
}

const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  'applied',
  'no-op',
  'precondition-failed',
  'ownership-unreadable',
  'unresolvable-label',
  'item-unavailable',
  'verify-failed',
  'write-failed',
  'state-unsaved',
  'mirror-failed',
])

/** A failure whose outcome kind is unknown is dropped, never the item. */
function mirrorFailureOf(value: unknown): MirrorFailure | null {
  if (!isRecord(value) || typeof value.at !== 'string' || !isRecord(value.outcome)) return null
  const kind = value.outcome.kind
  if (typeof kind !== 'string' || !OUTCOME_KINDS.has(kind)) return null
  return { at: value.at, outcome: value.outcome as unknown as WriteOutcome }
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
  const history = value.history.map(rowOf).filter((row): row is StoredHistoryRow => row !== null)
  const issue = typeof value.issue === 'number' && Number.isSafeInteger(value.issue) ? value.issue : null
  return {
    kind: value.kind,
    number: value.number,
    keys,
    marked: value.marked,
    autoPlan: value.autoPlan,
    claimedAt: value.claimedAt,
    reviewCycles: value.reviewCycles,
    history,
    updatedAt: value.updatedAt,
    issue,
    mirrorFailure: mirrorFailureOf(value.mirrorFailure),
  }
}

function recordOf(value: unknown): RepoRecord | null {
  if (!isRecord(value) || typeof value.seededAt !== 'string' || !isRecord(value.items)) return null
  // A record carrying any other non-null field was frozen while the terminal cockpit held it, so it reseeds once from labels.
  if (Object.entries(value).some(([key, field]) => key !== 'seededAt' && key !== 'items' && field !== null)) return null
  const items: Record<string, StoredItem> = {}
  for (const raw of Object.values(value.items)) {
    const item = itemOf(raw)
    if (item !== null) items[itemKey(item.kind, item.number)] = item
  }
  return { seededAt: value.seededAt, items }
}

/** A missing, malformed or newer-version file is empty; a bad item is dropped, never its repository. */
export function parseFile(value: unknown): PipelineStateFile {
  if (!isRecord(value) || typeof value.version !== 'number' || value.version > FILE_VERSION || !isRecord(value.repositories)) return emptyFile()
  const repositories: Record<string, RepoRecord> = {}
  for (const [repoId, raw] of Object.entries(value.repositories)) {
    const record = recordOf(raw)
    if (record !== null) repositories[repoId] = record
  }
  return { version: FILE_VERSION, repositories }
}

/** One stored item per reconciled item, from what the board just showed. */
export function seedFrom(state: Extract<RepositoryState, { readonly ok: true }>, at: string): RepoRecord {
  const items: Record<string, StoredItem> = {}
  for (const item of state.items) {
    const history = item.stageHistory.map((entry): StoredHistoryRow => ({ at: entry.at, action: 'seed', add: [entry.key], remove: [], actor: entry.actor })).slice(-HISTORY_CAP)
    const claimedAt = item.stageHistory.findLast((entry) => IN_FLIGHT.has(entry.key))?.at ?? null
    items[itemKey(item.kind, item.number)] = {
      kind: item.kind,
      number: item.number,
      keys: item.matchedKeys.filter((key) => key !== 'marker' && key !== 'autoPlan'),
      marked: item.matchedKeys.includes('marker'),
      autoPlan: item.matchedKeys.includes('autoPlan'),
      claimedAt,
      reviewCycles: item.reviewCycleCount ?? 0,
      history,
      updatedAt: at,
      issue: item.kind === 'pull-request' ? (item.linked) : null,
      mirrorFailure: null,
    }
  }
  return { seededAt: at, items }
}

function holds(item: StoredItem | undefined, key: LabelKey): boolean {
  if (item === undefined) return false
  if (key === 'marker') return item.marked
  if (key === 'autoPlan') return item.autoPlan
  return item.keys.includes(key)
}

/** The next stored item, or a refusal when the stored keys do not satisfy `expect`. A missing item with an empty `present` is created. */
export function transition(record: RepoRecord, ref: { readonly kind: PipelineItemKind; readonly number: number }, input: TransitionInput): TransitionResult {
  const existing = record.items[itemKey(ref.kind, ref.number)]
  if (!input.expect.present.every((key) => holds(existing, key)) || input.expect.absent.some((key) => holds(existing, key))) return { ok: false, reason: 'precondition-failed' }

  let keys = [...(existing?.keys ?? [])]
  let marked = existing?.marked ?? false
  let autoPlan = existing?.autoPlan ?? false
  let claimedAt = existing?.claimedAt ?? null
  const apply = (key: LabelKey, on: boolean): void => {
    if (key === 'marker') marked = on
    else if (key === 'autoPlan') autoPlan = on
    else keys = on ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter((k) => k !== key)
  }
  for (const key of input.remove) apply(key, false)
  for (const key of input.add) {
    apply(key, true)
    if (IN_FLIGHT.has(key)) claimedAt = input.at
  }

  const issue = ref.kind === 'pull-request' ? (existing?.issue ?? input.issue) : null
  const changed =
    existing === undefined || keys.length !== existing.keys.length || keys.some((k, i) => k !== existing.keys[i]) || marked !== existing.marked || autoPlan !== existing.autoPlan || issue !== existing.issue
  if (!changed) return { ok: true, item: existing, changed: false }
  const row: StoredHistoryRow = { at: input.at, action: input.action, add: input.add, remove: input.remove, actor: input.actor }
  const item: StoredItem = {
    kind: ref.kind,
    number: ref.number,
    keys,
    marked,
    autoPlan,
    claimedAt,
    reviewCycles: (existing?.reviewCycles ?? 0) + (CYCLE_ACTIONS.has(input.action) ? 1 : 0),
    history: [...(existing?.history ?? []), row].slice(-HISTORY_CAP),
    updatedAt: input.at,
    issue,
    mirrorFailure: existing?.mirrorFailure ?? null,
  }
  return { ok: true, item, changed: true }
}

// A repeated failure keeps its first instant, so a retry that fails the same way is not a new event.
function failureKeyOf(outcome: WriteOutcome): string {
  return outcome.kind === 'write-failed' ? `write-failed|${outcome.classification}|${outcome.stderr}` : JSON.stringify(outcome)
}

/** The record unchanged when the item is missing or already holds this failure. */
export function recordMirror(record: RepoRecord, ref: { readonly kind: PipelineItemKind; readonly number: number }, failure: MirrorFailure | null): RepoRecord {
  const existing = record.items[itemKey(ref.kind, ref.number)]
  if (existing === undefined) return record
  const held = existing.mirrorFailure
  const same = held === failure || (held !== null && failure !== null && failureKeyOf(held.outcome) === failureKeyOf(failure.outcome))
  return same ? record : withItem(record, { ...existing, mirrorFailure: failure })
}

export function withItem(record: RepoRecord, item: StoredItem): RepoRecord {
  return { ...record, items: { ...record.items, [itemKey(item.kind, item.number)]: item } }
}

/** Drops closed or merged items, which keeps the tracked list bounded. */
export function prune(record: RepoRecord, closed: readonly number[]): RepoRecord {
  if (closed.length === 0) return record
  const gone = new Set(closed)
  const items = Object.fromEntries(Object.entries(record.items).filter(([, item]) => !gone.has(item.number)))
  return Object.keys(items).length === Object.keys(record.items).length ? record : { ...record, items }
}

/** A repository the store does not hold, or one recorded as held by the terminal cockpit, is unseeded and reseeds once from labels. */
export function viewOf(record: RepoRecord | undefined): PipelineView {
  if (record === undefined) return { kind: 'unseeded' }
  return { kind: 'store', items: Object.values(record.items) }
}

export function trackedOf(record: RepoRecord | undefined): readonly TrackedRef[] | null {
  if (record === undefined) return null
  return Object.values(record.items).map((item) => ({ kind: item.kind, number: item.number, keys: fullKeysOf(item) }))
}

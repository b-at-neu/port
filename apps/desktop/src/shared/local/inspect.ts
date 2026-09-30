// The one place the denial log (#77's `readDenials`) is turned into
// something an operator can act on (#85). Pure — no `gh`, no filesystem, no
// second reader of the log — so it compiles under `typecheck:web` and can be
// called from both the renderer (over IPC'd data, #80) and main (#81) from
// one implementation. Lives in `shared/`, not `main/local/`, because it
// joins two adapters' outputs (`DenialsRead` and `SessionScan`) and
// `main/local/` is explicitly a single-source adapter (ENGINEERING §1).
//
// Three decisions carry this file, restated here because they are the parts
// a caller must not violate:
//
// - A shape is a grouping key, never a parse, and never a re-derivation of
//   the hook's reasoning (`shapeOf` below never decides *which* rail fired
//   on a `session`-actor `deny` — the log does not say, and ENGINEERING §3
//   forbids guessing a harness decision from its inputs).
// - Bursts are computed over `deny` entries only, so a run of `miss` lines
//   (the #63 false-positive class) never reads as a signal worth acting on.
// - Attribution fails toward "unknown", never toward a guessed role — a
//   wrong attribution is unrecoverable misinformation; an honest "unknown
//   session" only costs specificity.
import type { RepoId } from '../repos'
import type { SessionRecord, SessionRole, SessionScan } from '../sessions/types'
import { shapeOf } from './shape'
import type { DenialActor, DenialDecision, DenialsFailureKind, DenialSummary, DenialsRead } from './types'

export { shapeOf } from './shape'

/** Idle-window idiom `shared/sessions/types.ts` established (`ACTIVE_WITHIN_MS`)
 *  — tests and #80 share these two constants rather than each carrying its
 *  own threshold. */
export const BURST_MIN_COUNT = 3
export const BURST_WINDOW_MS = 10 * 60 * 1000

/** Set only for a `session` actor (Decision 4) — every other actor kind's
 *  attribution already lives in the actor field itself. A session id the
 *  scan cannot resolve is `unknown-session`, never guessed at a role; a scan
 *  that never ran or that failed is a third state, `attribution-unavailable`,
 *  never collapsed into `unknown-session` — the two mean different things to
 *  an operator deciding whether to re-scan. */
export type SessionAttribution =
  | { readonly kind: 'attributed'; readonly role: SessionRole; readonly repoId: RepoId | null; readonly label: string | null; readonly lastActivityAt: string }
  | { readonly kind: 'unknown-session' }
  | { readonly kind: 'attribution-unavailable'; readonly reason: 'not-scanned' | 'scan-failed' }

/** Every analysed entry lands in exactly one bucket, summing to `analysed`.
 *  `unattributable` covers a legacy line's bare uuid and a malformed line —
 *  the ticket's "clearly mark lines that cannot be attributed". */
export interface AttributionTally {
  readonly agentAttributed: number
  readonly sessionAttributed: number
  readonly sessionUnresolved: number
  readonly attributionUnavailable: number
  readonly unattributable: number
}

/** `undecided` is a legacy or malformed line: it carries no decision field at
 *  all, so it is neither a denial nor a miss. The top-level `DenialSummary`
 *  (passed through verbatim, never recomputed here) already splits legacy
 *  from malformed; a group's own counts do not need to. */
export interface DecisionCounts {
  readonly deny: number
  readonly miss: number
  readonly gateClear: number
  readonly hookError: number
  readonly undecided: number
  readonly total: number
}

/** One actor's own qualifying run of `deny` entries on one shape, inside
 *  `burstWindowMs`, reaching at least `burstMinCount` — the ticket's
 *  "highlight clustered repeats". At most one per shape group; the largest
 *  qualifying window across that shape's actors wins (see `bestWindowFor`). */
export interface Burst {
  readonly actorKey: string
  readonly count: number
  readonly startedAt: string
  readonly endedAt: string
}

/** `key` is stable and collision-free — see `actorKeyOf`. `actor` is `null`
 *  only for the malformed lines folded in here (Decision: nothing vanishes,
 *  even a line the actor ladder could not parse). `attribution` is set only
 *  when `actor.kind === 'session'`. */
export interface ActorGroup {
  readonly key: string
  readonly actor: DenialActor | null
  readonly attribution: SessionAttribution | null
  readonly counts: DecisionCounts
  readonly firstSeen: string | null
  readonly lastSeen: string | null
  readonly shapeCount: number
}

/** `sample` is the newest entry's subject verbatim, capped at 200 characters
 *  — the operator's one piece of real text per group. Malformed lines carry
 *  no subject and never form a shape (excluded here; still counted in
 *  `AttributionTally.unattributable` and `analysed`). */
export interface ShapeGroup {
  readonly shape: string
  readonly counts: DecisionCounts
  readonly actorCount: number
  readonly firstSeen: string | null
  readonly lastSeen: string | null
  readonly sample: string
  readonly burst: Burst | null
}

/** Mirrors `DenialsRead`'s three-arm union exactly, so an absent log stays a
 *  distinct healthy state end to end and can never render as "no denials". */
export type DenialInspection =
  | { readonly ok: true; readonly present: false; readonly path: string; readonly readAt: string }
  | {
      readonly ok: true
      readonly present: true
      readonly path: string
      readonly readAt: string
      /** #77's `DenialSummary`, passed through by reference — never
       *  recomputed, so the two can never disagree (Data & contracts). */
      readonly summary: DenialSummary
      readonly attribution: AttributionTally
      readonly byActor: readonly ActorGroup[]
      readonly byShape: readonly ShapeGroup[]
      readonly analysed: number
      readonly capped: boolean
    }
  | { readonly ok: false; readonly kind: DenialsFailureKind; readonly message: string; readonly path: string; readonly readAt: string }

export interface InspectDenialsInput {
  readonly read: DenialsRead
  /** `null` = the caller ran no session scan at all — distinct from a scan
   *  that ran and failed (`sessions.ok === false`); both degrade every
   *  session actor to `attribution-unavailable`, with a different `reason`. */
  readonly sessions: SessionScan | null
  readonly burstMinCount?: number
  readonly burstWindowMs?: number
}

const SAMPLE_MAX_LENGTH = 200
const LABEL_MAX_LENGTH = 120

/** Stable, collision-free key for the actor grouping. A malformed entry
 *  carries `actor: null` (the ladder could not even attempt to parse it),
 *  so it groups under its own raw line rather than vanishing. */
export function actorKeyOf(actor: DenialActor | null, raw: string): string {
  if (actor === null) return `unattributed:${raw}`
  switch (actor.kind) {
    case 'stage-agent':
      return `stage-agent:${actor.agent}`
    case 'subagent':
      return `subagent:${actor.agentType}`
    case 'subagent-signal':
      return `subagent-signal:${actor.signal}`
    case 'session':
      return `session:${actor.sessionId}`
    case 'unattributed':
      return `unattributed:${actor.raw}`
  }
}

type SessionLookup = { readonly kind: 'available'; readonly index: ReadonlyMap<string, SessionRecord> } | { readonly kind: 'unavailable'; readonly reason: 'not-scanned' | 'scan-failed' }

/** Built once over `scan.sessions` — never a scan per entry, or a 500-entry
 *  inspection would be O(entries × sessions). */
function buildSessionLookup(sessions: SessionScan | null): SessionLookup {
  if (sessions === null) return { kind: 'unavailable', reason: 'not-scanned' }
  if (!sessions.ok) return { kind: 'unavailable', reason: 'scan-failed' }
  const index = new Map<string, SessionRecord>()
  for (const record of sessions.sessions) index.set(record.sessionId, record)
  return { kind: 'available', index }
}

function labelFor(record: SessionRecord): string | null {
  const raw = record.customTitle ?? record.summary ?? record.firstPrompt
  if (raw === null) return null
  return raw.length > LABEL_MAX_LENGTH ? raw.slice(0, LABEL_MAX_LENGTH) : raw
}

/** `null` for every actor kind but `session` — its attribution already lives
 *  in the actor field. Fails toward `unknown-session`/`attribution-unavailable`,
 *  never toward a guessed role (Decision 4). */
function attributionFor(actor: DenialActor | null, lookup: SessionLookup): SessionAttribution | null {
  if (actor === null || actor.kind !== 'session') return null
  if (lookup.kind === 'unavailable') return { kind: 'attribution-unavailable', reason: lookup.reason }
  const record = lookup.index.get(actor.sessionId)
  if (!record) return { kind: 'unknown-session' }
  return { kind: 'attributed', role: record.role, repoId: record.repoId, label: labelFor(record), lastActivityAt: record.lastActivityAt }
}

function emptyCounts(): { deny: number; miss: number; gateClear: number; hookError: number; undecided: number; total: number } {
  return { deny: 0, miss: 0, gateClear: 0, hookError: 0, undecided: 0, total: 0 }
}

function incrementCounts(counts: ReturnType<typeof emptyCounts>, decision: DenialDecision | null): void {
  counts.total++
  if (decision === null) counts.undecided++
  else if (decision === 'deny') counts.deny++
  else if (decision === 'miss') counts.miss++
  else if (decision === 'gate-clear') counts.gateClear++
  else if (decision === 'hook-error') counts.hookError++
}

function tallyAttribution(
  tally: { agentAttributed: number; sessionAttributed: number; sessionUnresolved: number; attributionUnavailable: number; unattributable: number },
  actor: DenialActor | null,
  attribution: SessionAttribution | null,
): void {
  if (actor === null || actor.kind === 'unattributed') {
    tally.unattributable++
    return
  }
  if (actor.kind === 'stage-agent' || actor.kind === 'subagent' || actor.kind === 'subagent-signal') {
    tally.agentAttributed++
    return
  }
  // actor.kind === 'session' — attributionFor always returns non-null here.
  switch (attribution?.kind) {
    case 'attributed':
      tally.sessionAttributed++
      break
    case 'unknown-session':
      tally.sessionUnresolved++
      break
    case 'attribution-unavailable':
      tally.attributionUnavailable++
      break
  }
}

/** An entry whose timestamp will not parse still counts everywhere else, but
 *  never sets first/last and never participates in a burst — an unreadable
 *  clock is not a clock reading zero. */
function parseEpoch(timestamp: string | null): number | null {
  if (timestamp === null) return null
  const epoch = Date.parse(timestamp)
  return Number.isNaN(epoch) ? null : epoch
}

interface SeenTracker {
  firstSeen: string | null
  firstEpoch: number | null
  lastSeen: string | null
  lastEpoch: number | null
}

function newSeenTracker(): SeenTracker {
  return { firstSeen: null, firstEpoch: null, lastSeen: null, lastEpoch: null }
}

function updateSeen(tracker: SeenTracker, timestamp: string | null, epoch: number | null): void {
  if (epoch === null || timestamp === null) return
  if (tracker.firstEpoch === null || epoch < tracker.firstEpoch) {
    tracker.firstEpoch = epoch
    tracker.firstSeen = timestamp
  }
  if (tracker.lastEpoch === null || epoch > tracker.lastEpoch) {
    tracker.lastEpoch = epoch
    tracker.lastSeen = timestamp
  }
}

interface TimedPoint {
  readonly epoch: number
  readonly timestamp: string
}

interface CandidateWindow {
  readonly count: number
  readonly startEpoch: number
  readonly endEpoch: number
  readonly startedAt: string
  readonly endedAt: string
}

/** A wider or later window never beats a bigger one — "the largest such
 *  window wins" reads as most entries first, then the longer span, then the
 *  earlier start, so the result is deterministic across runs. */
function isBetterWindow(a: CandidateWindow, b: CandidateWindow): boolean {
  if (a.count !== b.count) return a.count > b.count
  const aDuration = a.endEpoch - a.startEpoch
  const bDuration = b.endEpoch - b.startEpoch
  if (aDuration !== bDuration) return aDuration > bDuration
  return a.startEpoch < b.startEpoch
}

/** Sliding window over one actor's own `deny` timestamps on one shape,
 *  ascending. Never combines two actors' entries — a burst is what *one*
 *  actor did, not a shape's aggregate traffic. */
function bestWindowFor(points: readonly TimedPoint[], minCount: number, windowMs: number): CandidateWindow | null {
  let left = 0
  let best: CandidateWindow | null = null
  for (let right = 0; right < points.length; right++) {
    while (points[right]!.epoch - points[left]!.epoch > windowMs) left++
    const count = right - left + 1
    if (count >= minCount) {
      const candidate: CandidateWindow = {
        count,
        startEpoch: points[left]!.epoch,
        endEpoch: points[right]!.epoch,
        startedAt: points[left]!.timestamp,
        endedAt: points[right]!.timestamp,
      }
      if (best === null || isBetterWindow(candidate, best)) best = candidate
    }
  }
  return best
}

/** Pure over an already-read `DenialsRead` and an already-scanned
 *  `SessionScan` — no `gh`, no filesystem, no second read of the log
 *  (`main/local/` already did that). */
export function inspectDenials(input: InspectDenialsInput): DenialInspection {
  const { read, sessions } = input
  const burstMinCount = input.burstMinCount ?? BURST_MIN_COUNT
  const burstWindowMs = input.burstWindowMs ?? BURST_WINDOW_MS

  if (!read.ok) {
    return { ok: false, kind: read.kind, message: read.message, path: read.path, readAt: read.readAt }
  }
  if (!read.present) {
    return { ok: true, present: false, path: read.path, readAt: read.readAt }
  }

  const lookup = buildSessionLookup(sessions)
  const tally = { agentAttributed: 0, sessionAttributed: 0, sessionUnresolved: 0, attributionUnavailable: 0, unattributable: 0 }

  interface WorkingActorGroup {
    readonly actor: DenialActor | null
    readonly attribution: SessionAttribution | null
    readonly counts: ReturnType<typeof emptyCounts>
    readonly seen: SeenTracker
    readonly shapes: Set<string>
  }
  interface WorkingShapeGroup {
    readonly counts: ReturnType<typeof emptyCounts>
    readonly seen: SeenTracker
    readonly actors: Set<string>
    sample: string
    sampleEpoch: number | null
  }

  const actorGroups = new Map<string, WorkingActorGroup>()
  const shapeGroups = new Map<string, WorkingShapeGroup>()
  // shape -> actorKey -> this actor's own deny timestamps on that shape,
  // never mixed across actors (bursts are per-actor, per shape).
  const denyPoints = new Map<string, Map<string, TimedPoint[]>>()

  for (const entry of read.entries) {
    const attribution = attributionFor(entry.actor, lookup)
    tallyAttribution(tally, entry.actor, attribution)

    const epoch = parseEpoch(entry.timestamp)
    const key = actorKeyOf(entry.actor, entry.raw)

    let actorGroup = actorGroups.get(key)
    if (!actorGroup) {
      actorGroup = { actor: entry.actor, attribution, counts: emptyCounts(), seen: newSeenTracker(), shapes: new Set() }
      actorGroups.set(key, actorGroup)
    }
    incrementCounts(actorGroup.counts, entry.decision)
    updateSeen(actorGroup.seen, entry.timestamp, epoch)

    // Malformed entries have no subject, so they never form a shape — still
    // counted above in the tally and below in `analysed`, so nothing vanishes.
    if (entry.form === 'malformed' || entry.subject === null) continue

    const shape = shapeOf(entry.subject)
    actorGroup.shapes.add(shape)

    let shapeGroup = shapeGroups.get(shape)
    if (!shapeGroup) {
      shapeGroup = { counts: emptyCounts(), seen: newSeenTracker(), actors: new Set(), sample: '', sampleEpoch: null }
      shapeGroups.set(shape, shapeGroup)
    }
    incrementCounts(shapeGroup.counts, entry.decision)
    updateSeen(shapeGroup.seen, entry.timestamp, epoch)
    shapeGroup.actors.add(key)
    if (epoch !== null && (shapeGroup.sampleEpoch === null || epoch >= shapeGroup.sampleEpoch)) {
      shapeGroup.sampleEpoch = epoch
      shapeGroup.sample = entry.subject.length > SAMPLE_MAX_LENGTH ? entry.subject.slice(0, SAMPLE_MAX_LENGTH) : entry.subject
    }

    if (entry.decision === 'deny' && epoch !== null) {
      let perActor = denyPoints.get(shape)
      if (!perActor) {
        perActor = new Map()
        denyPoints.set(shape, perActor)
      }
      const points = perActor.get(key)
      if (points) points.push({ epoch, timestamp: entry.timestamp! })
      else perActor.set(key, [{ epoch, timestamp: entry.timestamp! }])
    }
  }

  const bursts = new Map<string, Burst>()
  for (const [shape, perActor] of denyPoints) {
    let best: { readonly actorKey: string; readonly window: CandidateWindow } | null = null
    for (const [actorKey, unsorted] of perActor) {
      const sorted = [...unsorted].sort((a, b) => a.epoch - b.epoch)
      const window = bestWindowFor(sorted, burstMinCount, burstWindowMs)
      if (!window) continue
      if (best === null || isBetterWindow(window, best.window) || (!isBetterWindow(best.window, window) && actorKey < best.actorKey)) {
        best = { actorKey, window }
      }
    }
    if (best) bursts.set(shape, { actorKey: best.actorKey, count: best.window.count, startedAt: best.window.startedAt, endedAt: best.window.endedAt })
  }

  const byActor: ActorGroup[] = [...actorGroups.entries()].map(([key, group]) => ({
    key,
    actor: group.actor,
    attribution: group.attribution,
    counts: group.counts,
    firstSeen: group.seen.firstSeen,
    lastSeen: group.seen.lastSeen,
    shapeCount: group.shapes.size,
  }))

  const byShape: ShapeGroup[] = [...shapeGroups.entries()].map(([shape, group]) => ({
    shape,
    counts: group.counts,
    actorCount: group.actors.size,
    firstSeen: group.seen.firstSeen,
    lastSeen: group.seen.lastSeen,
    sample: group.sample,
    burst: bursts.get(shape) ?? null,
  }))

  // Both orderings are total and deterministic, so a re-render never
  // reshuffles rows (Data & contracts → "Both orderings are total").
  const lastSeenEpoch = (value: string | null): number => {
    if (value === null) return -Infinity
    const epoch = Date.parse(value)
    return Number.isNaN(epoch) ? -Infinity : epoch
  }
  byActor.sort((a, b) => {
    if (a.counts.deny !== b.counts.deny) return b.counts.deny - a.counts.deny
    if (a.counts.total !== b.counts.total) return b.counts.total - a.counts.total
    const lastDiff = lastSeenEpoch(b.lastSeen) - lastSeenEpoch(a.lastSeen)
    if (lastDiff !== 0) return lastDiff
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  byShape.sort((a, b) => {
    const burstDiff = (b.burst ? 1 : 0) - (a.burst ? 1 : 0)
    if (burstDiff !== 0) return burstDiff
    if (a.counts.deny !== b.counts.deny) return b.counts.deny - a.counts.deny
    if (a.counts.total !== b.counts.total) return b.counts.total - a.counts.total
    const lastDiff = lastSeenEpoch(b.lastSeen) - lastSeenEpoch(a.lastSeen)
    if (lastDiff !== 0) return lastDiff
    return a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0
  })

  return {
    ok: true,
    present: true,
    path: read.path,
    readAt: read.readAt,
    summary: read.summary,
    attribution: tally,
    byActor,
    byShape,
    analysed: read.entries.length,
    capped: read.capped,
  }
}

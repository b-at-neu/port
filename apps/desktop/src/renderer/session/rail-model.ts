// #103: pure decision logic for the session rail — row ordering, row status,
// capacity, the usage notice, and the fallback selection after a dismiss.
// No DOM here; `rail.ts` renders from these.
import type { HostedSessionSnapshot, SessionKey, SessionRateLimit } from '@/types/hosting'
import { END_COPY } from '@/renderer/session/copy'
import type { UsageNotice } from '@/types/session'
import { aggregateUsage, type SessionUsage, type UsageTotals } from '@/utils/hosting/usage'

interface RailRowStatus {
  readonly glyph: string
  readonly word: string
}

const STATUS_BY_OPEN_PHASE: Readonly<Record<Exclude<HostedSessionSnapshot['phase'], 'ended'>, RailRowStatus>> = {
  starting: { glyph: '◌', word: 'Starting' },
  ready: { glyph: '○', word: 'Idle' },
  streaming: { glyph: '●', word: 'Working' },
  interrupting: { glyph: '◐', word: 'Stopping' },
  closing: { glyph: '◐', word: 'Closing' },
}

/** `pendingPermissions.length > 0` overrides every open phase with `Needs
 *  you` — a prompt arriving mid-turn is not a new phase of its own
 *  (`types/hosting.ts`'s own note on `HostedSessionSnapshot`). An
 *  `ended` session always uses `END_COPY`'s title, regardless of pending
 *  permissions (an ended session reports none — `handle.ts`'s
 *  `broker.cancelAll()`). */
export function rowStatus(snapshot: HostedSessionSnapshot): RailRowStatus {
  if (snapshot.phase === 'ended') {
    const title = snapshot.end !== null ? END_COPY[snapshot.end.reason].title : 'Ended'
    return { glyph: '■', word: title }
  }
  if (snapshot.pendingPermissions.length > 0) return { glyph: '◆', word: 'Needs you' }
  return STATUS_BY_OPEN_PHASE[snapshot.phase]
}

/** Every snapshot, open ones first by `startedAt`, then ended ones by
 *  `startedAt` — stable, so a row never jumps when its own status changes
 *  (only when it crosses the open/ended boundary). */
export function rowsFor(snapshots: readonly HostedSessionSnapshot[]): readonly HostedSessionSnapshot[] {
  const byStartedAt = (a: HostedSessionSnapshot, b: HostedSessionSnapshot): number => a.startedAt.localeCompare(b.startedAt)
  const open = snapshots.filter((snapshot) => snapshot.phase !== 'ended').slice().sort(byStartedAt)
  const ended = snapshots.filter((snapshot) => snapshot.phase === 'ended').slice().sort(byStartedAt)
  return [...open, ...ended]
}

export function openCount(snapshots: readonly HostedSessionSnapshot[]): number {
  return snapshots.filter((snapshot) => snapshot.phase !== 'ended').length
}

/** `2 of 4 open`, `4 of 4 open — close one to start another` at the limit,
 *  or `5 of 3 open — close 2 to start another` once lowering the limit
 *  leaves more open than it now allows. */
export function capacityLine(open: number, limit: number): string {
  if (open < limit) return `${String(open)} of ${String(limit)} open`
  if (open === limit) return `${String(open)} of ${String(limit)} open — close one to start another`
  return `${String(open)} of ${String(limit)} open — close ${String(open - limit)} to start another`
}

/** The newest reading by `observedAt` across every session — every open
 *  session draws on the same shared usage limit, so one reading speaks for
 *  all of them. Returns a notice only for `warning`/`rejected`; a newer
 *  `allowed` reading, or a `resetsAt` already in the past relative to `now`,
 *  both clear it — a stale warning is worse than none. */
export function usageNotice(snapshots: readonly HostedSessionSnapshot[], now: Date): UsageNotice | null {
  let newest: SessionRateLimit | null = null
  for (const snapshot of snapshots) {
    const reading = snapshot.rateLimit
    if (reading === null) continue
    if (newest === null || reading.observedAt > newest.observedAt) newest = reading
  }
  if (newest === null || newest.status === 'allowed') return null
  if (newest.resetsAt !== null && new Date(newest.resetsAt).getTime() <= now.getTime()) return null
  return { status: newest.status, window: newest.window, resetsAt: newest.resetsAt }
}

/** The newest still-open session other than `removedKey` — `null` when none
 *  is left, in which case the controller shows the empty state instead. */
export function fallbackSelection(snapshots: readonly HostedSessionSnapshot[], removedKey: SessionKey | null): SessionKey | null {
  const candidates = snapshots.filter((snapshot) => snapshot.phase !== 'ended' && snapshot.sessionKey !== removedKey)
  if (candidates.length === 0) return null
  return candidates.reduce((newest, candidate) => (candidate.startedAt > newest.startedAt ? candidate : newest)).sessionKey
}

export interface UsageSummary {
  readonly session: UsageTotals
  readonly all: UsageTotals
}

/** `session` is this session's own reading; `all` sums every snapshot in
 *  `session:list`, ended included, since their cost was already spent. */
export function usageSummary(current: SessionUsage | null, snapshots: readonly HostedSessionSnapshot[]): UsageSummary {
  return { session: aggregateUsage([current]), all: aggregateUsage(snapshots.map((snapshot) => snapshot.usage)) }
}

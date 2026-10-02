// #265: pure redispatch-floor filtering and sent-to-started confirmation —
// no I/O, no SDK import. `dispatcher.ts` is the only caller.
import type { HostedTask } from '../../shared/hosting/types'
import type { DispatchRecord } from '../../shared/dispatch/types'
import type { TickActionable } from '../../shared/tick/types'

/** The cockpit's own tick floor (`PIPELINE.md` → "The pacing ladder") — a
 *  slow label swap (GitHub's own read-after-write lag) must never look like
 *  "nothing sent yet" and double-dispatch the same candidate within one
 *  cockpit tick's worth of time. */
export const REDISPATCH_FLOOR_MS = 270_000

export interface SelectDispatchesParams {
  readonly dispatchable: readonly TickActionable[]
  /** This repository's own bounded recent list — every state
   *  (`sent`/`started`/`not-started`), never pre-filtered, since the floor
   *  applies to all three: a confirmed `started` dispatch is exactly the
   *  case that must never double-fire, and an unconfirmed `not-started` one
   *  still waits out the same floor before trying again. */
  readonly recent: readonly DispatchRecord[]
  readonly now: Date
}

/** Drops any candidate this process already dispatched (same `agent` +
 *  `number`) within `REDISPATCH_FLOOR_MS`, by its most recent record for
 *  that pair. Everything else passes through in the candidates' own order —
 *  `dispatcher.ts` never re-sorts. */
export function selectDispatches(params: SelectDispatchesParams): readonly TickActionable[] {
  const { dispatchable, recent, now } = params
  return dispatchable.filter((candidate) => {
    const matches = recent.filter((r) => r.agent === candidate.agent && r.number === candidate.number)
    if (matches.length === 0) return true
    const newest = matches.reduce((a, b) => (Date.parse(a.at) > Date.parse(b.at) ? a : b))
    return now.getTime() - Date.parse(newest.at) >= REDISPATCH_FLOOR_MS
  })
}

export interface ConfirmStartedResult {
  readonly updated: readonly DispatchRecord[]
  /** Exactly the records this call moved from `sent` to `started` — the
   *  caller's own cue to call `ledger.record` for each, never before a task
   *  is actually seen. */
  readonly newlyStarted: readonly DispatchRecord[]
}

/** Matches a pending (`sent`) record to a `HostedTask` by `description` and
 *  `subagentType` (`port:<agent>-agent`) — the two fields `turn.ts`'s
 *  `specFor` set verbatim on the `Agent()` call, so a match here is proof
 *  the dispatcher's turn actually started the agent it was told to, not
 *  merely that the turn completed. Every other record passes through
 *  unchanged. */
export function confirmStarted(recent: readonly DispatchRecord[], tasks: readonly HostedTask[]): ConfirmStartedResult {
  const newlyStarted: DispatchRecord[] = []
  const updated = recent.map((record) => {
    if (record.state !== 'sent') return record
    const description = `${record.agent} #${String(record.number)}`
    const subagentType = `port:${record.agent}-agent`
    const matched = tasks.some((t) => t.description === description && t.subagentType === subagentType)
    if (!matched) return record
    const started: DispatchRecord = { ...record, state: 'started' }
    newlyStarted.push(started)
    return started
  })
  return { updated, newlyStarted }
}

/** Once the dispatcher's own turn reaches `result` with no matching task for
 *  a still-`sent` record, that record becomes `not-started` — never left at
 *  `sent` forever, since nothing turns it `started` after the turn that was
 *  supposed to start it has already finished. It may redispatch after the
 *  floor, the same as any other candidate. */
export function markUnconfirmed(recent: readonly DispatchRecord[]): readonly DispatchRecord[] {
  return recent.map((record) => (record.state === 'sent' ? { ...record, state: 'not-started' } : record))
}

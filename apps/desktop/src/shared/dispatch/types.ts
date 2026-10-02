// Renderer-safe contract for operator control over dispatch (#110): drain,
// resume, and halt. No import here may reach a Node builtin — the header
// controls (`renderer/src/board/dispatch.ts`) are this ticket's own
// consumer, the same rule `shared/actions/types.ts` and
// `shared/writes/types.ts` already state for themselves.
import type { PipelineItemKind } from '../github/types'
import type { ItemActionResult } from '../actions/types'
import type { RepoId } from '../repos'
import type { StageAgent } from '../tick/types'
import type { ClaimWriteResult } from '../writes/types'

export const DISPATCH_COMMANDS = ['drain', 'resume', 'halt'] as const
export type DispatchCommand = (typeof DISPATCH_COMMANDS)[number]

/**
 * The app's one drain switch (`<userData>/dispatch.json`) —
 * `main/tick/dispatchable.ts`'s own gate reads this, never a per-repository
 * fact. One `open` arm, three draining arms: `unread` before the on-disk
 * file has ever been read (so `registerIpc()` stays synchronous and a
 * not-yet-read file never reads as open), `unreadable` for a malformed file,
 * an unsupported version, or one this app could not read at all, and
 * `operator` for a deliberate drain — `since` is the persisted instant it
 * started, never re-derived from `Date.now()` on every read.
 */
export type DrainState =
  | { readonly gate: 'open' }
  | { readonly gate: 'draining'; readonly reason: 'operator'; readonly since: string }
  | { readonly gate: 'draining'; readonly reason: 'unread' }
  | { readonly gate: 'draining'; readonly reason: 'unreadable'; readonly message: string; readonly path: string }

/**
 * One in-flight item's own halt outcome. `stopped` mirrors `stopPlan`'s own
 * `applied` write — `removedLabel` is the in-flight label's resolved name,
 * `attachedAgent` names an agent or session this app found attached (never
 * `null` standing in for "checked and found none" vs "did not check" — an
 * item with no attachment simply reports `null`, since this app cannot stop
 * one either way, #106's job). `skipped` never reached `applyItemAction` at
 * all. `refused` is any other `ItemActionResult` the write chokepoint itself
 * returned — a stale read, an unclaimed scope, a precondition that no
 * longer holds — rendered with the same copy an ordinary row's action note
 * already uses.
 */
export type HaltItemOutcome =
  | {
      readonly kind: 'stopped'
      readonly number: number
      readonly itemKind: PipelineItemKind
      readonly repoId: RepoId
      readonly removedLabel: string
      readonly attachedAgent: string | null
      /** #265: `true` when this halt also called the dispatcher's own
       *  `stopFor()` against an app-dispatched agent for this item —
       *  `false` for every other case (the cockpit's own agent, or no
       *  dispatcher at all), never omitted so the renderer can always
       *  render `haltItemLine`'s own "Stopped <agent> #<n>" line
       *  unconditionally. */
      readonly stoppedTask: boolean
    }
  | {
      readonly kind: 'skipped'
      readonly number: number
      readonly itemKind: PipelineItemKind
      readonly repoId: RepoId
      readonly reason: 'session-required' | 'not-owned' | 'viewer-unknown'
      readonly owner: string | null
    }
  | { readonly kind: 'refused'; readonly number: number; readonly itemKind: PipelineItemKind; readonly repoId: RepoId; readonly result: ItemActionResult }

/**
 * `haltDispatch`'s own report. `aborted` is the one outcome that never
 * touched a single item's labels — the drain write itself failed, and
 * resetting labels with the gate not durably closed would only re-dispatch
 * everything this call was meant to stop. `completed` always ran, even when
 * it stopped nothing at all (an empty `items` list is a real "nothing was
 * in flight", never conflated with the aborted case above).
 */
export type HaltReport =
  | { readonly kind: 'aborted'; readonly reason: 'drain-unwritable'; readonly message: string; readonly path: string }
  | { readonly kind: 'completed'; readonly items: readonly HaltItemOutcome[] }

/**
 * `'dispatch:control'`'s response. `drain` always carries what
 * `DrainStore.current()` reads right after the command ran, no matter which
 * arm below fired — this app's header line renders straight off it. `resume`
 * is the one command that can be refused outright (plan's own **Data &
 * contracts**: "Resume is refused when its write fails; drain is not") —
 * `drain`'s own write failure is instead visible as `persisted: false`,
 * since the gate still closed in memory and the operator got the stop they
 * asked for.
 */
export type DispatchControlResult =
  | { readonly ok: true; readonly command: 'drain'; readonly drain: DrainState; readonly persisted: boolean }
  | { readonly ok: true; readonly command: 'resume'; readonly drain: DrainState }
  | { readonly ok: false; readonly command: 'resume'; readonly reason: 'drain-unwritable'; readonly message: string; readonly path: string }
  | { readonly ok: true; readonly command: 'halt'; readonly drain: DrainState; readonly report: HaltReport }

/**
 * #265: who dispatches for one ready repository, read fresh off the claim
 * every pass (`main/dispatch/dispatcher.ts`'s own `consider`, never cached)
 * — mirrors `docs/COORDINATION.md`'s dispatch row. `held` naming `dispatch`
 * → `app`; `unreadable` → `nobody` (both sides stand down, matching
 * `plan-gate`'s own fail direction); anything else (`absent`, or held
 * without `dispatch`) → `cockpit`.
 */
export type DispatchOwner = 'cockpit' | 'app' | 'nobody'

/** #265: one `Agent()` call this app's own dispatcher turn sent, tracked
 *  from `sent` (the turn landed, no confirming `task_started` yet) through
 *  `started` (confirmed, and `ledger.record` has run) or `not-started` (the
 *  dispatcher's turn reached `result` with no matching task — may redispatch
 *  after `REDISPATCH_FLOOR_MS`). Bounded to the newest 20 per repository,
 *  the same idiom `hosting/tasks.ts`'s own `MAX_TASKS` establishes. */
export interface DispatchRecord {
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly state: 'sent' | 'started' | 'not-started'
  readonly at: string
}

/** #265: this app's own dispatcher state for one ready repository — the
 *  owner line's own **UX states** table, rendered only while `owner ===
 *  'app'`. `idle` covers both "no dispatcher session yet" and "a live one
 *  with nothing currently to report"; `active` carries the per-dispatch
 *  detail `recent` feeds. */
export type DispatcherState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'active'; readonly recent: readonly DispatchRecord[] }
  | { readonly kind: 'refused'; readonly reason: 'budget-unported' }
  | { readonly kind: 'dispatcher-failed'; readonly reason: 'at-capacity'; readonly limit: number }
  | { readonly kind: 'dispatcher-failed'; readonly reason: 'runtime' | 'plugin' }
  | { readonly kind: 'agents-missing'; readonly agent: StageAgent }

/** #265: `BoardSnapshot.dispatch`'s own one-row-per-ready-repository shape —
 *  `state` is always `{ kind: 'idle' }` when `owner !== 'app'`, since only
 *  this app's own dispatcher ever has anything richer to report. */
export interface RepoDispatchStatus {
  readonly repoId: RepoId
  readonly owner: DispatchOwner
  readonly state: DispatcherState
  /** `true` while this repository's dispatcher session is itself draining
   *  (the app-wide drain switch) — the owner line appends " · draining",
   *  never a fifth `DispatcherState` member for what is really an
   *  orthogonal fact. */
  readonly draining: boolean
  /** The live dispatcher session's own adopted id (`HostedSessionSnapshot.
   *  claudeSessionId`) — `null` before `init` arrives, or whenever no
   *  dispatcher session is live. `board/relay.ts` compares a pending
   *  relay's own `sessionId` against this to decide "Send to agent" vs the
   *  paste instruction (#265) — the one piece of `DispatcherState` cannot
   *  express on its own, since it crosses every state the same way. */
  readonly claudeSessionId: string | null
  /** The claim's own `claimedAt` (#265) — `null` unless `owner` is `'app'`.
   *  The owner line's own "claimed 14:02" clause reads this, never a second
   *  clock of its own. */
  readonly claimedAt: string | null
}

/** `'dispatch:claim:set'`'s response (#265) — the mirror of
 *  `shared/gate/types.ts`'s own `GateClaimResponse`, for the `dispatch`
 *  scope instead of `plan-gate`. Always re-reads and recomputes the owner
 *  after writing, the same "carries the state as it now is" rule. */
export type DispatchClaimSetResult = { readonly kind: 'ok'; readonly status: RepoDispatchStatus } | { readonly kind: 'failed'; readonly result: ClaimWriteResult }

/** `'dispatch:relay'`'s response (#265) — `not-owner` when this app no
 *  longer holds the `dispatch` claim for `repoId`, `unknown-agent` when
 *  `agentId` names no task this dispatcher started, `no-dispatcher` when no
 *  dispatcher session is live for this repository at all. */
export type DispatchRelayResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'not-owner' | 'unknown-agent' | 'no-dispatcher' }

// Renderer-safe contract for operator control over dispatch (#110, #314):
// per-repository run state (run/drain/pause) and halt everything. No import
// here may reach a Node builtin — the header controls (`renderer/src/board/
// dispatch.ts`, `renderer/src/board/run-state.ts`) are this ticket's own
// consumer, the same rule `shared/actions/types.ts` and `shared/writes/
// types.ts` already state for themselves.
import type { PipelineItemKind } from '../github/types'
import type { ItemActionResult } from '../actions/types'
import type { RepoId } from '../repos'
import type { StageAgent, TickObservationKind } from '../tick/types'
import type { WriteOutcome } from '../writes/types'

/**
 * #314: `dispatch.json`'s own per-repository run state — `dispatching`
 * (today's "open"), `draining` (today's global drain, scoped to one
 * repository) or `paused` (the hard stop: nothing dispatches or writes, and
 * the *transition* into it also stops every in-flight agent for that
 * repository). The renderer's own display copy capitalizes this first state
 * as a proper noun; the persisted and typed value stays `'dispatching'`
 * everywhere else (`desktop-dispatch`'s own naming rail).
 */
export const RUN_STATES = ['dispatching', 'draining', 'paused'] as const
export type RunState = (typeof RUN_STATES)[number]

/** The three per-repository operator commands — `run`/`drain`/`pause` map
 *  onto `RUN_TARGET` 1:1, which is what `resolveDispatchControl` writes. */
export const RUN_COMMANDS = ['run', 'drain', 'pause'] as const
export type RunCommand = (typeof RUN_COMMANDS)[number]

export const RUN_TARGET: Readonly<Record<RunCommand, RunState>> = {
  run: 'dispatching',
  drain: 'draining',
  pause: 'paused',
}

/** `halt` joins the three per-repository commands as the one command that
 *  carries no `repoId` at all — it pauses every registered repository.
 *  `take-over` (#331) overwrites a `terminal` ownership record and runs —
 *  reached only from the confirmed Take over dialog, never a `RUN_TARGET`
 *  entry, since it is a compound action rather than a plain state write. */
export const DISPATCH_COMMANDS = [...RUN_COMMANDS, 'halt', 'take-over'] as const
export type DispatchCommand = (typeof DISPATCH_COMMANDS)[number]

/** The run-state store's own read status — `unread` before the on-disk file
 *  has ever been read (so a not-yet-loaded store answers every repository as
 *  paused, never silently as open), `unreadable` for a malformed file, an
 *  unsupported version, or one this app could not read at all, `loaded`
 *  otherwise (including when the file is simply absent — no entries, every
 *  repository paused). */
export type RunStateStoreStatus = { readonly kind: 'unread' } | { readonly kind: 'loaded' } | { readonly kind: 'unreadable'; readonly message: string; readonly path: string }

/** One repository's own persisted run state — `since: null` means no saved
 *  entry for this repository at all, which reads as paused the same as an
 *  explicit `paused` entry would. */
export interface RepoRunState {
  readonly repoId: RepoId
  readonly state: RunState
  readonly since: string | null
}

export interface RunStatesSnapshot {
  readonly store: RunStateStoreStatus
  readonly repositories: readonly RepoRunState[]
}

/** One in-flight item's own halt outcome. `stopped` mirrors `stopPlan`'s own
 *  `applied` write — `removedLabel` is the in-flight label's resolved name,
 *  `attachedAgent` names an agent or session this app found attached (never
 *  `null` standing in for "checked and found none" vs "did not check" — an
 *  item with no attachment simply reports `null`, since this app cannot stop
 *  one either way, #106's job). `skipped` never reached `applyItemAction` at
 *  all. `refused` is any other `ItemActionResult` the write chokepoint itself
 *  returned — a stale read, an unclaimed scope, a precondition that no
 *  longer holds — rendered with the same copy an ordinary row's action note
 *  already uses.
 */
export type HaltItemOutcome =
  | {
      readonly kind: 'stopped'
      readonly number: number
      readonly itemKind: PipelineItemKind
      readonly repoId: RepoId
      readonly removedLabel: string
      readonly attachedAgent: string | null
      /** #326: `true` when this halt also closed an app-launched stage
       *  session for this item — `false` for every other case (the
       *  cockpit's own agent, or no app-launched session at all), never
       *  omitted so the renderer can always render `haltItemLine`'s own
       *  "Stopped <agent> #<n>" line unconditionally. */
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
 * touched a single item's labels — the run-state write itself failed, and
 * resetting labels with the gate not durably closed would only re-dispatch
 * everything this call was meant to stop. `completed` always ran, even when
 * it stopped nothing at all (an empty `items` list is a real "nothing was
 * in flight", never conflated with the aborted case above).
 */
export type HaltReport =
  | { readonly kind: 'aborted'; readonly reason: 'run-state-unwritable'; readonly message: string; readonly path: string }
  | { readonly kind: 'completed'; readonly items: readonly HaltItemOutcome[] }

/**
 * `'dispatch:control'`'s response (#314, #331). `run`/`drain`/`take-over`
 * each take ownership first (`take-over` with `force: true`, so it refuses
 * only on a genuine write failure); a `terminal-owned`/`ownership-unreadable`
 * refusal on `run`/`drain` makes no run-state write at all. `drain`'s own
 * run-state write failure is instead visible as `persisted: false`, since the
 * gate still closed in memory and the operator got the stop they asked for.
 * `pause`/`halt` are never refused outright — a failed run-state write
 * surfaces inside `report` as `{ kind: 'aborted' }` instead, and a failed
 * ownership release afterwards surfaces as `released: false`, never thrown.
 * `halt` carries no `repoId` at all.
 */
export type DispatchControlResult =
  | { readonly ok: true; readonly command: 'run'; readonly repoId: RepoId; readonly runState: RepoRunState }
  | { readonly ok: false; readonly command: 'run'; readonly repoId: RepoId; readonly reason: 'terminal-owned' | 'ownership-unreadable' | 'unwritable' | 'unreadable'; readonly message?: string; readonly since?: string; readonly path?: string }
  | { readonly ok: true; readonly command: 'drain'; readonly repoId: RepoId; readonly runState: RepoRunState; readonly persisted: boolean }
  | { readonly ok: false; readonly command: 'drain'; readonly repoId: RepoId; readonly reason: 'terminal-owned' | 'ownership-unreadable' | 'unwritable' | 'unreadable'; readonly message?: string; readonly since?: string; readonly path?: string }
  | { readonly ok: true; readonly command: 'pause'; readonly repoId: RepoId; readonly runState: RepoRunState; readonly report: HaltReport; readonly released: boolean }
  | { readonly ok: true; readonly command: 'halt'; readonly report: HaltReport; readonly released: boolean }
  | { readonly ok: true; readonly command: 'take-over'; readonly repoId: RepoId; readonly runState: RepoRunState }
  | { readonly ok: false; readonly command: 'take-over'; readonly repoId: RepoId; readonly reason: 'unwritable'; readonly message: string; readonly path: string }

/**
 * #331: who runs the pipeline for one ready repository, read fresh off
 * `.agents/cockpit.json` every pass (`main/dispatch/dispatcher.ts`'s own
 * `consider`, never cached) — mirrors `docs/COORDINATION.md`'s verdict
 * table. `absent` → `none` (neither side owns it yet); `unreadable` stands on
 * its own, since neither this app nor a terminal cockpit can tell who should
 * run it.
 */
export type DispatchOwner = 'app' | 'terminal' | 'none' | 'unreadable'

/** #326: one stage-session launch this app's loop attempted, tracked from
 *  `started` (the launch returned ok and the session has not ended) through
 *  `ended` (the session's own handle reports `phase === 'ended'`, or it was
 *  closed by `shutdown()`/`stopFor`/`standDown`) or `failed` (the launcher
 *  itself refused or threw). `detail` is set only on `failed`. Bounded to
 *  the newest 20 per repository, the same idiom `hosting/persist.ts`'s own
 *  retain limits establish. */
export interface DispatchRecord {
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly state: 'started' | 'ended' | 'failed'
  readonly at: string
  readonly detail: string | null
}

/** #326: this app's own dispatch state for one ready repository — the owner
 *  line's own **UX states** table, rendered only while `owner === 'app'`.
 *  `idle` covers both "nothing launched yet" and "nothing currently to
 *  report"; `active` carries the per-launch detail `recent` feeds.
 *  `no-launcher` holds visibly while candidates exist but no `StageLauncher`
 *  is wired (the state between this ticket and #327); `at-capacity` reports
 *  how many candidates are waiting for a free hosted-session slot. */
export type DispatcherState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'active'; readonly recent: readonly DispatchRecord[] }
  /** #293: `commands.budget` is set, but the shipped script can't be run —
   *  unparseable, a non-`node` runner, or a copy too old to accept
   *  `--session` (`message` already carries which, and the exact remedy;
   *  `budget-gate.ts` assembles it, so this stays a generic one-line
   *  render). Nothing dispatches while this holds — the gate that can't run
   *  must fail closed. */
  | { readonly kind: 'budget-unavailable'; readonly message: string }
  | { readonly kind: 'no-launcher' }
  | { readonly kind: 'at-capacity'; readonly limit: number; readonly waiting: number }

/** #293: one candidate the budget gate acted on this pass, alongside an
 *  ordinary dispatch or hold — rendered as its own line under the owner
 *  line, never folded into `DispatcherState` itself, since several notes
 *  can coexist with one dispatcher state. `held`/`gate-failed` carry the
 *  detail the script or the gate itself produced; the two escalation notes
 *  carry the resolved `needsHuman` label name and the removed trigger name,
 *  so the renderer never types a label literal. */
export type BudgetNote =
  | { readonly kind: 'held'; readonly number: number; readonly line: string }
  | { readonly kind: 'held-dispatched'; readonly number: number }
  | { readonly kind: 'escalated'; readonly number: number; readonly needsHumanLabel: string; readonly commentFailedMessage: string | null }
  | { readonly kind: 'escalation-failed'; readonly number: number; readonly needsHumanLabel: string; readonly triggerLabel: string; readonly outcome: WriteOutcome }
  | { readonly kind: 'gate-failed'; readonly number: number; readonly message: string }

/** #292: one machine-observation write this app attempted this pass, bounded
 *  to the newest 20 per repository (the same `RECENT_LIMIT` idiom
 *  `DispatchRecord` already establishes). `outcome` is the mapping
 *  `main/actions/observe.ts`'s own table carries from a raw `WriteOutcome` —
 *  `written` (applied), `already` (no-op), `moved` (the item changed under
 *  it — a precondition failure or a vanished item), `refused` (#331: a
 *  terminal cockpit took ownership mid-pass, an unreadable ownership record,
 *  or a key this vocabulary cannot resolve — ownership gates every write
 *  uniformly now, so there is no longer a scope to distinguish), or `failed`
 *  (the `gh` call itself errored, or the attempt threw). */
export interface ObservationRecord {
  readonly kind: TickObservationKind
  readonly number: number
  readonly itemKind: PipelineItemKind
  readonly at: string
  readonly outcome: 'written' | 'already' | 'moved' | 'refused' | 'failed'
  readonly comment: 'posted' | 'failed' | 'none'
}

/** #293: one ready repository's own budget-gate status — `line` is the
 *  sweep's own session clause (`bin/budget.mjs`'s `renderTickClause`,
 *  verbatim), `problem` is set only while the most recent sweep itself
 *  failed (rows stay open and keep counting), and `notes` is replaced
 *  whenever a pass actually runs the per-candidate gate, kept otherwise —
 *  bounded to 20, the same idiom `DispatchRecord`'s own `RECENT_LIMIT`
 *  establishes. */
export interface BudgetStatus {
  readonly line: string | null
  readonly problem: string | null
  readonly notes: readonly BudgetNote[]
}

/** #265, #331: `BoardSnapshot.dispatch`'s own one-row-per-ready-repository
 *  shape — `state` is always `{ kind: 'idle' }` when `owner !== 'app'`, since
 *  only this app's own dispatcher ever has anything richer to report. */
export interface RepoDispatchStatus {
  readonly repoId: RepoId
  readonly owner: DispatchOwner
  readonly state: DispatcherState
  /** #314: this repository's own persisted run state — the owner line
   *  appends " · draining"/" · paused" for the two non-dispatching values,
   *  never a fifth `DispatcherState` member for what is really an
   *  orthogonal fact. */
  readonly runState: RunState
  /** The ownership record's own `since` (#331) — `null` unless `owner` is
   *  `'app'` or `'terminal'`. The owner line's own "since 14:02" clause reads
   *  this, never a second clock of its own. */
  readonly ownedSince: string | null
  /** Set only while `owner === 'unreadable'` — `.agents/cockpit.json`'s own
   *  read failure, for the "can't be read (<reason>)" copy. */
  readonly unreadableMessage: string | null
  /** #293: `null` iff `commands.budget` is `null` — otherwise populated
   *  regardless of `owner`, since the sweep that produces it keeps going
   *  while this app's own agents are still working even after ownership
   *  moves elsewhere. */
  readonly budget: BudgetStatus | null
  /** #292: the machine-observation writes this app has made for this
   *  repository, newest last — `[]` while `owner !== 'app'`, or before the
   *  first observation pass runs. `board/owner.ts`'s owner line appends the
   *  newest record's clause and lists every record (newest first) in its
   *  hover title. */
  readonly observed: readonly ObservationRecord[]
}

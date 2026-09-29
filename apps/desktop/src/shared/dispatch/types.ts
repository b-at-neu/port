// Renderer-safe contract for operator control over dispatch (#110): drain,
// resume, and halt. No import here may reach a Node builtin — the header
// controls (`renderer/src/board/dispatch.ts`) are this ticket's own
// consumer, the same rule `shared/actions/types.ts` and
// `shared/writes/types.ts` already state for themselves.
import type { PipelineItemKind } from '../github/types'
import type { ItemActionResult } from '../actions/types'
import type { RepoId } from '../repos'

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
  | { readonly kind: 'stopped'; readonly number: number; readonly itemKind: PipelineItemKind; readonly repoId: RepoId; readonly removedLabel: string; readonly attachedAgent: string | null }
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

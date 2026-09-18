// Pure: the liveness diff against this app's own dispatch ledger (`ledger.ts`),
// ported verbatim from scripts/port-tick/liveness.mjs's own `classifyUnmatched`
// and `RETRY_TRIGGER` — pinned against that file, both directions, by
// `scripts/checks/desktop-tick.mjs`'s dynamic import, the same idiom
// `desktop-local.mjs` already uses for `templates/worktrees.mjs`'s `correlate`.
//
// `capped` is currently unreachable from `plan.ts` alone: reaching it needs a
// prior automatic `reset`, and nothing under `main/tick/` writes a label —
// #106 (dispatch) is what makes a reset, and therefore `capped`, reachable.
// The shared case table is what keeps this whole ladder a decision rather
// than prose that could quietly stop matching it.
import type { LabelKey } from '../../shared/labels/vocabulary'

export type LedgerState = 'dispatched' | 'suspect' | 'reset'

export interface LedgerRow {
  readonly state: LedgerState
  readonly resets: number
}

export type UnmatchedClass = 'no-record' | 'suspect' | 'reset' | 'capped'

export interface UnmatchedResult {
  readonly class: UnmatchedClass
  readonly nextState?: LedgerState
  readonly nextResets?: number
}

/**
 * Classifies one in-flight item with no live match against its ledger row —
 * `undefined` for an item this process never dispatched. At most one
 * automatic reset per item per session, exactly `scripts/port-tick/liveness.mjs`'s
 * own four-rung ladder:
 *
 * - No row at all → `no-record`: report-only forever.
 * - Row `dispatched` (first unmatched tick) → `suspect`: debounce one tick.
 * - Row `suspect`, still unmatched → `reset`: provably dead, safe to reset.
 * - Already reset once and stalled again → `capped`: report, never reset twice.
 */
export function classifyUnmatched(row: LedgerRow | undefined): UnmatchedResult {
  if (!row) return { class: 'no-record' }
  if (row.state === 'dispatched') return { class: 'suspect', nextState: 'suspect', nextResets: row.resets }
  if (row.state === 'suspect' && row.resets === 0) return { class: 'reset', nextState: 'reset', nextResets: 1 }
  return { class: 'capped' }
}

/** The retry mapping from an in-flight label back to its trigger label,
 *  transcribed byte-for-byte from `scripts/port-tick/liveness.mjs`'s own
 *  `RETRY_TRIGGER` — `scripts/checks/desktop-tick.mjs` pins this against
 *  that file, both directions, keys and values. A third copy alongside
 *  `shared/actions/plan.ts`'s own (`desktop-actions`'s pin) — deliberate:
 *  that one recovers an operator's manual retry click, this one names a
 *  stalled claim's own recovery target, and neither may import the other
 *  across the `shared/`↔`main/` boundary each keeps for its own reasons. */
export const RETRY_TRIGGER: Readonly<Record<string, LabelKey>> = {
  planning: 'ready',
  inProgress: 'planApproved',
  reviewing: 'readyForReview',
  revising: 'needsRevision',
  refreshing: 'refreshBranch',
}

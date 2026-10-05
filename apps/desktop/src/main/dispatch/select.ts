// #326: pure redispatch-floor filtering, the re-read survivor test, and the
// budget note's comment-failure clause — no I/O. `dispatcher.ts` is the only
// caller; `survived`/`commentFailureMessage` moved here to keep that file
// under the 500-line limit (docs/ENGINEERING.md §7).
import type { StageRecord } from './launch'
import type { ResolvedItem } from '../../shared/github/types'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { TickActionable } from '../../shared/tick/types'
import type { WriteOutcome } from '../../shared/writes/types'

/** The cockpit's own tick floor (`PIPELINE.md` → "The pacing ladder") — a
 *  slow label swap (GitHub's own read-after-write lag) must never look like
 *  "nothing sent yet" and double-dispatch the same candidate within one
 *  cockpit tick's worth of time. */
export const REDISPATCH_FLOOR_MS = 270_000

export interface SelectDispatchesParams {
  readonly dispatchable: readonly TickActionable[]
  /** This repository's own bounded recent list, every state — the floor
   *  applies to all three: a live launch is exactly the case that must
   *  never double-fire, and a `failed` one still waits out the same floor
   *  before trying again. */
  readonly recent: readonly StageRecord[]
  readonly now: Date
}

/** Drops any candidate this process already launched (same `agent` +
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

/** The re-read survivor test (PIPELINE.md → "The dispatcher" step 5): the
 *  trigger's own resolved name is still present, no other role-bearing
 *  label (anything but a marker) is present alongside it, and the viewer is
 *  still among the assignees. Anything else is "moved" — dropped, never
 *  dispatched this pass. */
export function survived(resolved: ResolvedItem, candidate: TickActionable, vocabulary: LabelVocabulary, viewer: string): boolean {
  const triggerLabel = vocabulary.labels.find((l) => l.key === candidate.trigger)
  if (triggerLabel === undefined || !resolved.labels.includes(triggerLabel.name)) return false
  const roleBearingNames = new Set(vocabulary.labels.filter((l) => l.role !== 'marker').map((l) => l.name))
  const others = resolved.labels.filter((name) => name !== triggerLabel.name && roleBearingNames.has(name))
  // #292: a `refreshBranch` candidate tolerates exactly one co-present
  // role-bearing label — the sanctioned pair `main/tick/plan.ts`'s own
  // `actionableAndHeld` already allows (a refresh trigger sitting beside
  // another trigger it does not strand). Every other trigger keeps the
  // original single-label rule.
  const tolerance = candidate.trigger === 'refreshBranch' ? 1 : 0
  if (others.length > tolerance) return false
  return resolved.assignees.includes(viewer)
}

/** `null` for a comment that was never attempted or that itself applied — a
 *  short description otherwise, for the 'escalated' note's own "comment
 *  explaining why didn't post (<message>)" clause. */
export function commentFailureMessage(comment: WriteOutcome | null): string | null {
  if (comment === null || comment.kind === 'applied') return null
  return comment.kind === 'write-failed' ? comment.stderr : comment.kind
}

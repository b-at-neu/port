// Pure redispatch-floor filtering, the re-read survivor test, and the budget note's
// comment-failure clause, moved here to keep dispatcher.ts under the file-size limit.
import type { StageRecord } from './launch'
import type { ResolvedItem } from '../../shared/github/types'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { TickActionable } from '../../shared/tick/types'
import type { WriteOutcome } from '../../shared/writes/types'

/** The cockpit's own tick floor — a slow label swap must never look like "nothing sent yet"
 *  and double-dispatch the same candidate within one tick's worth of time. */
export const REDISPATCH_FLOOR_MS = 270_000

export interface SelectDispatchesParams {
  readonly dispatchable: readonly TickActionable[]
  /** This repository's own bounded recent list, every state — the floor applies to all three. */
  readonly recent: readonly StageRecord[]
  readonly now: Date
}

/** Drops any candidate already launched within `REDISPATCH_FLOOR_MS`. Everything else passes
 *  through in the candidates' own order. */
export function selectDispatches(params: SelectDispatchesParams): readonly TickActionable[] {
  const { dispatchable, recent, now } = params
  return dispatchable.filter((candidate) => {
    const matches = recent.filter((r) => r.agent === candidate.agent && r.number === candidate.number)
    if (matches.length === 0) return true
    const newest = matches.reduce((a, b) => (Date.parse(a.at) > Date.parse(b.at) ? a : b))
    return now.getTime() - Date.parse(newest.at) >= REDISPATCH_FLOOR_MS
  })
}

/** The re-read survivor test: the trigger's resolved name is still present, no other
 *  role-bearing label is present alongside it, and the viewer is still among the assignees. */
export function survived(resolved: ResolvedItem, candidate: TickActionable, vocabulary: LabelVocabulary, viewer: string): boolean {
  const triggerLabel = vocabulary.labels.find((l) => l.key === candidate.trigger)
  if (triggerLabel === undefined || !resolved.labels.includes(triggerLabel.name)) return false
  const roleBearingNames = new Set(vocabulary.labels.filter((l) => l.role !== 'marker').map((l) => l.name))
  const others = resolved.labels.filter((name) => name !== triggerLabel.name && roleBearingNames.has(name))
  // A refreshBranch candidate tolerates exactly one co-present role-bearing label; every other
  // trigger keeps the original single-label rule.
  const tolerance = candidate.trigger === 'refreshBranch' ? 1 : 0
  if (others.length > tolerance) return false
  return resolved.assignees.includes(viewer)
}

/** `null` for a comment that was never attempted or that itself applied — a short description otherwise. */
export function commentFailureMessage(comment: WriteOutcome | null): string | null {
  if (comment === null || comment.kind === 'applied') return null
  return comment.kind === 'write-failed' ? comment.stderr : comment.kind
}

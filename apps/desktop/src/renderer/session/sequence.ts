// #219: pure revision sequencing for `session:entries` — the same rule
// #84's tail poll already follows (never apply a delta out of order), lifted
// to a push-based stream instead of a poll response. No DOM, no IPC here.

export type SequenceOutcome = 'apply' | 'stale' | 'gap'

interface Revisioned {
  readonly revision: number
}

/** `revision` is monotonic per session. `lastRevision` is the revision this
 *  screen has already applied (`0` before anything has landed) —
 *  `delta.revision <= lastRevision` is a duplicate or a replay, already
 *  applied or superseded; exactly `lastRevision + 1` applies in order;
 *  anything higher is a gap this screen must never paper over by applying
 *  out of order. */
export function accept(lastRevision: number, delta: Revisioned): SequenceOutcome {
  if (delta.revision <= lastRevision) return 'stale'
  if (delta.revision === lastRevision + 1) return 'apply'
  return 'gap'
}

export type DrainResult<T> = { readonly kind: 'apply'; readonly deltas: readonly T[] } | { readonly kind: 'gap' }

/** After `session:attach` resolves with `attachRevision`, folds in whatever
 *  `session:entries` pushes arrived (and were buffered) while that round
 *  trip was in flight. Deltas at or below `attachRevision` are already
 *  covered by the attach's own window and are dropped; a gap in what
 *  remains means one push was missed entirely, and the caller must re-
 *  attach and re-render rather than apply the rest out of order. */
export function drainBuffered<T extends Revisioned>(attachRevision: number, buffered: readonly T[]): DrainResult<T> {
  const relevant = [...buffered].filter((delta) => delta.revision > attachRevision).sort((a, b) => a.revision - b.revision)

  let expected = attachRevision + 1
  const toApply: T[] = []
  for (const delta of relevant) {
    if (delta.revision === expected) {
      toApply.push(delta)
      expected += 1
    } else if (delta.revision > expected) {
      return { kind: 'gap' }
    }
    // delta.revision < expected: a duplicate already folded in -- skipped.
  }
  return { kind: 'apply', deltas: toApply }
}

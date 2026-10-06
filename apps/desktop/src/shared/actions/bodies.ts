// No runtime import here, so a layer 1 check can dynamically import this
// file under Node's own type stripping with nothing else to resolve first.
export const GATE_CLEARED_HEADING = '## Gate cleared'
export const CHANGES_REQUESTED_HEADING = '## Changes requested'
export const PIPELINE_ESCALATION_HEADING = '## Pipeline Escalation'

// The single source `observation.ts` and `escalationOf` both import, so a
// cycle-cap reason string never drifts into two separate copies.
export const CYCLE_CAP_ESCALATION_MARKER = 'review cycles reached the cap of'

export const CYCLE_GRANT_LINE = '### Cycle grant'

// The unblock comment, plus a `### Cycle grant` block on the one-shot
// cycle-cap override (`cycleGrantCount` counts exactly these comments).
export function gateClearedBody(route: 'revision' | 'review', opts?: { readonly cycleGrant?: boolean }): string {
  const target = route === 'revision' ? 'back to revision.' : 'back to review.'
  const base = `${GATE_CLEARED_HEADING}\nCleared by the operator in port: ${target}`
  if (!opts?.cycleGrant) return base
  return `${base}\n\n${CYCLE_GRANT_LINE}\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.`
}

/** The revise comment — FORMATS.md's "Changes requested" shape, verbatim. */
export function changesRequestedBody(headRefOid: string, note: string): string {
  return `${CHANGES_REQUESTED_HEADING}\nRequested by the operator on \`${headRefOid}\`, after approval:\n\n${note.trim()}`
}

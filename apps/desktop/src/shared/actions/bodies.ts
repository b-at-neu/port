// No runtime import here, so a layer 1 check can dynamically import this
// file under Node's own type stripping with nothing else to resolve first.
export const GATE_CLEARED_HEADING = '## Gate cleared'
export const CHANGES_REQUESTED_HEADING = '## Changes requested'
export const PIPELINE_ESCALATION_HEADING = '## Pipeline Escalation'

/** The unblock comment — one line naming the route's own consequence. */
export function gateClearedBody(route: 'revision' | 'review'): string {
  const target = route === 'revision' ? 'back to revision.' : 'back to review.'
  return `${GATE_CLEARED_HEADING}\nCleared by the operator in port: ${target}`
}

/** The revise comment — FORMATS.md's "Changes requested" shape, verbatim. */
export function changesRequestedBody(headRefOid: string, note: string): string {
  return `${CHANGES_REQUESTED_HEADING}\nRequested by the operator on \`${headRefOid}\`, after approval:\n\n${note.trim()}`
}

// No runtime import here, so a layer 1 check can dynamically import this
// file under Node's own type stripping with nothing else to resolve first.
export const GATE_CLEARED_HEADING = '## Gate cleared'
export const CHANGES_REQUESTED_HEADING = '## Changes requested'
export const PIPELINE_ESCALATION_HEADING = '## Pipeline Escalation'

// The single source `observation.ts` and `escalationOf` both import, so a
// cycle-cap reason string never drifts into two separate copies.
export const CYCLE_CAP_ESCALATION_MARKER = 'review cycles reached the cap of'

export const CYCLE_GRANT_LINE = '### Cycle grant'
export const REBASE_DECISIONS_LINE = '### Rebase decisions'

// The unblock comment, plus either a `### Cycle grant` block (counted by
// `cycleGrantCount`) or a `### Rebase decisions` block — never both.
export function gateClearedBody(
  route: 'revision' | 'review' | 'implementation',
  opts?: { readonly cycleGrant?: boolean; readonly rebaseDecisions?: readonly { readonly id: string; readonly path: string; readonly letter: string; readonly label: string }[] },
): string {
  const target = `back to ${route}.`
  const base = `${GATE_CLEARED_HEADING}\nCleared by the operator in port: ${target}`
  const decisions = opts?.rebaseDecisions ?? []
  if (opts?.cycleGrant && decisions.length > 0) throw new Error('a gate-cleared body carries a cycle grant or rebase decisions, never both')
  if (decisions.length > 0) {
    const lines = decisions.map((d) => `- ${d.id} \`${d.path}\` — **${d.letter} ${d.label}**`)
    return `${base}\n\n${REBASE_DECISIONS_LINE}\n${lines.join('\n')}`
  }
  if (!opts?.cycleGrant) return base
  return `${base}\n\n${CYCLE_GRANT_LINE}\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.`
}

/** The revise comment — FORMATS.md's "Changes requested" shape, verbatim. */
export function changesRequestedBody(headRefOid: string, note: string): string {
  return `${CHANGES_REQUESTED_HEADING}\nRequested by the operator on \`${headRefOid}\`, after approval:\n\n${note.trim()}`
}

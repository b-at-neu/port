// Every pure string the Repositories screen's own Worktrees tab renders
// (#86, #319) — moved out of the legacy `worktrees.ts` (deleted in the
// routing/main commit, which imports these instead of defining them a
// second time until then). No DOM here.
import type { InspectedWorktree, WorktreesReport } from '../../../shared/reclaimer/types'

/** One line per kind, naming what was refused — the plan's own **UX
 *  states** copy, verbatim where the plan gives an exact sentence. */
export function failureCopy(failure: Extract<WorktreesReport, { ok: false }>): string {
  switch (failure.kind) {
    case 'not-configured':
      return 'No commands.worktrees in this repository’s config, so worktree hygiene is unavailable. Run /port:init in it to install the reclamation script.'
    case 'unsupported-runner':
      return `commands.worktrees starts with ${failure.token}, which Port won’t run — only a node prefix is supported.`
    case 'unparseable-command':
      return 'commands.worktrees could not be parsed as a plain command — it may contain a shell metacharacter or an unbalanced quote. Nothing was run.'
    case 'not-found':
      return "Node.js wasn't found. Set PORT_NODE_PATH if it's installed somewhere unusual."
    case 'cwd-missing':
      return "This repository's working directory couldn't be found on disk."
    case 'script-failed':
      return `The reclamation script reported: ${failure.message}.`
    case 'report-unparseable':
      return "The script's output wasn't the expected JSON."
    case 'timeout':
      return 'Timed out after 60s.'
    case 'signalled':
      return 'The reclamation script was killed before it finished.'
    case 'output-too-large':
      return "The reclamation script's output was too large to read."
    case 'nonzero':
      return `The reclamation script exited with an error: ${failure.message}`
    case 'spawn-failed':
      return `Couldn't run Node.js: ${failure.message}`
  }
}

export function producerCopy(producer: InspectedWorktree['producer']): string | null {
  if (producer === 'operator') return 'operator session'
  if (producer === 'dispatched') return 'dispatched agent'
  return null
}

export function needsAttentionCount(worktrees: readonly InspectedWorktree[]): number {
  return worktrees.filter((w) => !w.reclaimable && (w.state === 'locked' || w.state === 'dirty' || w.state === 'unresolved')).length
}

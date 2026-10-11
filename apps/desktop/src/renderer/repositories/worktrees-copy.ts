// Every pure string the Repositories screen's own Worktrees tab renders.
// No DOM here.
import type { InspectedWorktree, ReclaimedWorktree, WorktreesReclaimResult, WorktreesReport } from '../../../shared/reclaimer/types'

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

// --- Reclaim -------------------------------------------------------------

// One named worktree when reclaiming a single row, the count otherwise.
export function reclaimDialogTitle(count: number, singleName: string | null): string {
  if (count === 1 && singleName !== null) return `Reclaim ${singleName}?`
  return `Reclaim ${String(count)} worktree${count === 1 ? '' : 's'}?`
}

export function reclaimDialogBody(): string {
  return 'Removes each finished worktree’s directory and deletes its merged branch. Locked or dirty worktrees are kept.'
}

export function reclaimDialogConfirmLabel(): string {
  return 'Reclaim worktrees'
}

export function reclaimNothingToReclaimTooltip(): string {
  return 'Nothing to reclaim. Only merged or empty worktrees can be.'
}

function failedEntryCopy(entry: ReclaimedWorktree): string {
  return `${entry.pathBasename}: ${entry.error ?? 'unknown reason'}`
}

/** The post-reclaim toast — the plan's own three example lines, generalized
 *  over however many candidates were reclaimed. */
export function reclaimResultToast(result: Extract<WorktreesReclaimResult, { ok: true }>): string {
  const failed = result.results.filter((r) => r.outcome === 'failed')
  const total = result.results.length
  if (failed.length === 0) return `Reclaimed ${String(result.removed)} worktree${result.removed === 1 ? '' : 's'}.`
  return `Reclaimed ${String(result.removed)} of ${String(total)}. ${failed.map(failedEntryCopy).join('; ')}`
}

export function reclaimFailureToast(result: Extract<WorktreesReclaimResult, { ok: false }>): string {
  return failureCopy(result)
}

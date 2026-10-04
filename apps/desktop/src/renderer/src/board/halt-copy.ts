// Shared stop-report copy (#110, #314) — one `HaltItemOutcome`/`HaltReport`
// rendering, used by `board/dispatch.ts`'s `Halt everything` (every
// repository) and `board/run-state.ts`'s per-repository `Pause`. Split out
// of `dispatch.ts` so the two modules never form a circular import between
// them.
import type { HaltItemOutcome, HaltReport } from '../../../shared/dispatch/types'
import { actionResultCopy } from './copy'

function skippedLine(outcome: Extract<HaltItemOutcome, { readonly kind: 'skipped' }>): string {
  const n = String(outcome.number)
  switch (outcome.reason) {
    case 'session-required':
      return `#${n} skipped — session required; your own /port:implement session owns it.`
    case 'not-owned':
      return `#${n} skipped — @${outcome.owner ?? 'someone else'} owns it.`
    case 'viewer-unknown':
      return `#${n} skipped — can't tell which account you're signed in as.`
  }
}

/** `attachedAgent` names a stage (`'review-agent'`) or a session
 *  (`'/port:implement session'`) — only the former shortens for the
 *  "Stopped <agent> #<n>" line (#265); the latter is left as-is, since this
 *  app never stops an operator's own `/port:implement` session. */
function agentLabel(attachedAgent: string | null): string {
  if (attachedAgent === null) return ''
  return attachedAgent.endsWith('-agent') ? attachedAgent.slice(0, -'-agent'.length) : attachedAgent
}

/** One line per outcome (plan's own **UX states**) — a stopped item names
 *  what this app removed and, when one exists, the agent or session it
 *  found still attached (this app cannot stop one — #106's job). #265: when
 *  this app itself dispatched the agent (`stoppedTask`), it replaces "still
 *  attached — this app can't stop it" with "Stopped <agent> #<n>.", since
 *  this app just did. A refused item reuses the ordinary row action's own
 *  result copy rather than a second wording for the same `ItemActionResult`. */
export function haltItemLine(outcome: HaltItemOutcome, now: Date): string {
  const n = String(outcome.number)
  switch (outcome.kind) {
    case 'stopped': {
      if (outcome.stoppedTask) {
        const agent = agentLabel(outcome.attachedAgent)
        return `#${n} ${outcome.removedLabel} → no stage. Stopped${agent ? ` ${agent}` : ''} #${n}.`
      }
      const attached = outcome.attachedAgent !== null ? ` ${outcome.attachedAgent} still attached — this app can't stop it.` : ''
      return `#${n} ${outcome.removedLabel} → no stage.${attached}`
    }
    case 'skipped':
      return skippedLine(outcome)
    case 'refused':
      return `#${n} not stopped — ${actionResultCopy({ action: 'stop', number: outcome.number, plan: null, currentStageName: null, result: outcome.result, now })}`
  }
}

/** The heading line for a `completed` report — `N stopped, M skipped`, plus
 *  a `, K not stopped` clause only when a refusal actually happened, so the
 *  ordinary case stays exactly the two-count example the plan itself gives. */
export function haltHeadingCopy(report: Extract<HaltReport, { readonly kind: 'completed' }>): string {
  const stopped = report.items.filter((item) => item.kind === 'stopped').length
  const skipped = report.items.filter((item) => item.kind === 'skipped').length
  const refused = report.items.filter((item) => item.kind === 'refused').length
  const refusedPart = refused > 0 ? `, ${String(refused)} not stopped` : ''
  return `Halted · ${String(stopped)} stopped, ${String(skipped)} skipped${refusedPart}`
}

/** The one line an `aborted` report ever shows — the run-state write itself
 *  failed, so nothing was touched and none of the copy above ever runs. The
 *  run-state file is named directly, never "dispatch still open" (#314). */
export function haltAbortedCopy(report: Extract<HaltReport, { readonly kind: 'aborted' }>): string {
  return `Nothing was halted — ${report.path} couldn't be written (${report.message}). Labels were left alone, because resetting them before ${report.path} actually closed would just start everything again.`
}

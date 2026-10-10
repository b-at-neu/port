// The one place a `DenialSummary` is built from entries, shared by the whole-file total (`main/local/denials.ts`) and the analysed-window total (`inspect.ts`), so the two scopes can never drift apart in how they count.
import type { DenialEntry, DenialSummary } from './types'

/** A `deny` from a `session` actor is `railDenials` (a rail held, never a missing permission), never folded into `agentDenials`. */
export function summarizeDenials(entries: readonly DenialEntry[]): DenialSummary {
  let agentDenials = 0
  let railDenials = 0
  let misses = 0
  let gateClears = 0
  let hookErrors = 0
  let legacy = 0
  let malformed = 0

  for (const entry of entries) {
    if (entry.form === 'legacy') legacy++
    if (entry.form === 'malformed') malformed++

    switch (entry.decision) {
      case 'miss':
        misses++
        break
      case 'gate-clear':
        gateClears++
        break
      case 'hook-error':
        hookErrors++
        break
      case 'deny':
        if (entry.actor?.kind === 'session') railDenials++
        else if (
          entry.actor?.kind === 'stage-agent' ||
          entry.actor?.kind === 'subagent' ||
          entry.actor?.kind === 'subagent-signal'
        )
          agentDenials++
        break
      default:
        break
    }
  }

  return { agentDenials, railDenials, misses, gateClears, hookErrors, legacy, malformed, total: entries.length }
}

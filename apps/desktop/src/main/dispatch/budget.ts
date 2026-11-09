import type { StageRecord } from '@/types/dispatch'

// Pure budget policy: the session name, the verdict vocabulary, the two-strike hold rule, and
// how stage records feed the ledger. No I/O — budget-gate.ts is what reads and writes the ledger.

import type { BudgetVerdict } from '@/types/dispatch'

/** One session log per dispatcher — sharing one log with the cockpit would close rows this
 *  app's own agents are still working through. */
export const BUDGET_SESSION = 'desktop'

export const BUDGET_VERDICTS = ['allow', 'exceeded', 'hold'] as const

/** `allow` dispatches and resets the hold streak; `exceeded` escalates; the first consecutive
 *  `hold` holds this pass, the second or later dispatches anyway and resets the streak. */
export function budgetRoute(verdict: BudgetVerdict, priorHolds: number): { readonly action: 'dispatch' | 'hold' | 'escalate'; readonly holds: number } {
  if (verdict === 'allow') return { action: 'dispatch', holds: 0 }
  if (verdict === 'exceeded') return { action: 'escalate', holds: 0 }
  return priorHolds === 0 ? { action: 'hold', holds: 1 } : { action: 'dispatch', holds: 0 }
}

/** `live`: descriptions of every `started` record. `completed`: every `ended` record whose own hand-back `outcome.kind === 'completed'`, not already in `live` — a `failed` record, and an `ended` record that crashed/errored/hit the usage limit, are in neither set, closing as lost rather than completed. */
export function budgetLiveSets(records: readonly StageRecord[]): { readonly live: readonly string[]; readonly completed: readonly string[] } {
  const live = [...new Set(records.filter((r) => r.state === 'started').map((r) => `${r.agent} #${String(r.number)}`))]
  const liveSet = new Set(live)
  const completed = [
    ...new Set(
      records
        .filter((r) => r.state === 'ended' && r.outcome?.kind === 'completed')
        .map((r) => `${r.agent} #${String(r.number)}`)
        .filter((d) => !liveSet.has(d)),
    ),
  ]
  return { live, completed }
}

/** The sum of every record's own `outcome.costUsd` — `null` when no record carries one yet. */
export function sumCostUsd(records: readonly StageRecord[]): number | null {
  const known = records.map((r) => r.outcome?.costUsd).filter((c): c is number => c !== null && c !== undefined)
  if (known.length === 0) return null
  return known.reduce((a, b) => a + b, 0)
}

/** `## Pipeline Escalation`'s body — `line` is the gate's own `exceeded` line, carried verbatim. A pull request's `sha` adds the `budget` marker a repeat is matched on. */
export function escalationBody(line: string, sha: string | null): string {
  const marker = sha === null || sha === '' ? '' : `\n<!-- port:escalation budget ${sha} -->`
  return `## Pipeline Escalation\n${line}\nThis app's dispatcher stopped here instead of dispatching. Raise \`budget.wallClockMinutes\`, or take the ticket over by hand.${marker}`
}

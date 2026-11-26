import type { StageRecord } from '@/types/dispatch'

// Budget policy: session name, verdicts, the two-strike hold rule, ledger feeds and the over-budget escalation.
// budget-gate.ts reads and writes the ledger.

import type { BudgetNote, BudgetVerdict } from '@/types/dispatch'
import type { ReadyEntry } from '@/types/actions'
import type { ReconciledItem } from '@/types/state'
import type { TickActionable } from '@/types/tick'
import type { WriteOutcome } from '@/types/writes'
import { labelName } from '@/utils/labels/vocabulary'
import type { Platform } from '@/main/platform'
import type { StateWriteContext } from '@/main/pipeline/context'
import { escalateToHuman } from '@/main/pipeline/operator/escalate'
import { budgetIntent } from '@/main/pipeline/incidents/raise'
import { escalationRepeats } from '@/utils/pipeline/gates'

/** One session log per dispatcher — sharing one log with the cockpit would close rows this
 *  app's own agents are still working through. */
export const BUDGET_SESSION = 'desktop'

export const BUDGET_VERDICTS = ['allow', 'exceeded', 'hold'] as const

/** `null` for a comment that was never attempted or that itself applied — a short description otherwise. */
function commentFailureMessage(comment: WriteOutcome | null): string | null {
  if (comment === null || comment.kind === 'applied') return null
  return comment.kind === 'write-failed' ? comment.stderr : comment.kind
}

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

interface EscalateOverBudgetParams {
  readonly entry: ReadyEntry
  readonly candidate: TickActionable
  readonly line: string
  readonly notes: BudgetNote[]
  readonly viewer: string
  /** The candidate's board item, read only for a pull request's head and comments. */
  readonly item: Pick<ReconciledItem, 'headRefOid' | 'comments'> | undefined
}

/** Swaps the candidate to `needsHuman` and records the outcome as a budget note. */
export async function escalateOverBudget(ctx: StateWriteContext & Pick<Platform, 'paths'>, params: EscalateOverBudgetParams): Promise<void> {
  const { entry, candidate, line, notes, viewer, item } = params
  const needsHumanLabel = labelName(entry.config.vocabulary, 'needsHuman') ?? 'needsHuman'
  const triggerLabel = labelName(entry.config.vocabulary, candidate.trigger) ?? candidate.trigger
  const sha = candidate.kind === 'pull-request' ? (item?.headRefOid ?? null) : null
  const repeats = sha !== null && escalationRepeats({ comments: item?.comments ?? undefined, cause: 'budget', sha })
  const escalation = await escalateToHuman(ctx, {
    entry,
    kind: candidate.kind,
    number: candidate.number,
    viewer,
    body: repeats ? null : escalationBody(line, sha),
    action: 'budget-escalate',
    incident: budgetIntent(candidate.trigger, item?.headRefOid ?? null),
    auditDir: ctx.paths.userData,
    scratchDir: ctx.paths.temp,
  })
  if (escalation.labels.kind === 'applied') {
    notes.push({ kind: 'escalated', number: candidate.number, needsHumanLabel, commentFailedMessage: commentFailureMessage(escalation.comment) })
  } else {
    notes.push({ kind: 'escalation-failed', number: candidate.number, needsHumanLabel, triggerLabel, outcome: escalation.labels })
  }
}

/** `## Pipeline Escalation`'s body — `line` is the gate's own `exceeded` line, carried verbatim. A pull request's `sha` adds the `budget` marker a repeat is matched on. */
export function escalationBody(line: string, sha: string | null): string {
  const marker = sha === null || sha === '' ? '' : `\n<!-- port:escalation budget ${sha} -->`
  return `## Pipeline Escalation\n${line}\nThis app's dispatcher stopped here instead of dispatching. Raise \`budget.wallClockMinutes\`, or take the ticket over by hand.${marker}`
}

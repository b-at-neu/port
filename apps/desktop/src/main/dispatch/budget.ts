// #293: pure composition over the shipped `bin/budget.mjs` — argument
// builders, output parsing, and the two-strike hold rule
// (`budgetRoute`, ported verbatim from `SKILL.md` → "Budget gate", since no
// case table exists for a decision this inseparable from the ledger I/O the
// script itself owns). No I/O, no `node` import — `budget-gate.ts` is what
// actually runs the script.
import type { HostedTask } from '../../shared/hosting/types'
import type { DispatchRecord } from '../../shared/dispatch/types'
import type { TickActionable } from '../../shared/tick/types'

/** One session log per dispatcher (`bin/budget.mjs`'s own `--session`) — a
 *  sweep closes every open row its own caller does not vouch for, so sharing
 *  one log with the cockpit would close rows this app's own agents are still
 *  working through. Declared once; every argument builder below appends it. */
export const BUDGET_SESSION = 'desktop'

export const BUDGET_VERDICTS = ['allow', 'exceeded', 'hold'] as const
export type BudgetVerdict = (typeof BUDGET_VERDICTS)[number]

/** The substring `bin/budget.mjs`'s own unrecognized-argument `die()` call
 *  produces for an older copy that predates `--session` — `budget-gate.ts`
 *  reads this off a `FAIL` line to tell "script can't run" apart from "script
 *  is simply out of date", which the owner line renders as two distinct UX
 *  states. */
export const OUTDATED_SCRIPT_SENTINEL = "unrecognized argument '--session'"

export function resetArgs(): readonly string[] {
  return ['reset', '--session', BUDGET_SESSION]
}

export function sweepArgs(params: { readonly live: readonly string[]; readonly completed: readonly string[] }): readonly string[] {
  return ['sweep', '--live', params.live.join(','), '--completed', params.completed.join(','), '--session', BUDGET_SESSION]
}

/** `--issue N` when `candidate.kind === 'issue'`, otherwise `--pr N` — the
 *  same number `turn.ts`'s own `specFor` names in the `Agent()` call's
 *  `description`, since the script keys its session-log row on whichever
 *  number this call used. */
export function dispatchArgs(candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'>, model: string): readonly string[] {
  const numberFlag = candidate.kind === 'issue' ? '--issue' : '--pr'
  return ['dispatch', numberFlag, String(candidate.number), '--stage', candidate.agent, '--model', model, '--session', BUDGET_SESSION]
}

/** The first line is the verdict; the second is the script's own
 *  human-readable line, echoed verbatim everywhere this app reports it.
 *  `null` when the first line is not one of `BUDGET_VERDICTS` — an unknown
 *  verdict is never read as `allow`. */
export function parseVerdict(stdout: string): { readonly verdict: BudgetVerdict; readonly line: string } | null {
  const lines = stdout.split('\n')
  const first = (lines[0] ?? '').trim()
  if (!(BUDGET_VERDICTS as readonly string[]).includes(first)) return null
  return { verdict: first as BudgetVerdict, line: (lines[1] ?? '').trim() }
}

const SWEEP_PREFIX = '**Budget:** '

/** The last line starting `**Budget:** `, with the bold markers stripped —
 *  `null` when no such line is present (a sweep that failed before printing
 *  one). Scanning from the end skips any `note` lines the script prints
 *  first for an unparseable `--live`/`--completed` entry. */
export function parseSweepLine(stdout: string): string | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line !== undefined && line.startsWith(SWEEP_PREFIX)) return line.slice(SWEEP_PREFIX.length)
  }
  return null
}

/** Ported verbatim from `SKILL.md` → "Budget gate": `allow` dispatches and
 *  resets the hold streak; `exceeded` escalates; the first consecutive
 *  `hold` holds this pass (an unreadable ledger must not dispatch blind),
 *  the second or later dispatches anyway (the ceiling isn't enforceable on
 *  this one until a read succeeds) and resets the streak. */
export function budgetRoute(verdict: BudgetVerdict, priorHolds: number): { readonly action: 'dispatch' | 'hold' | 'escalate'; readonly holds: number } {
  if (verdict === 'allow') return { action: 'dispatch', holds: 0 }
  if (verdict === 'exceeded') return { action: 'escalate', holds: 0 }
  return priorHolds === 0 ? { action: 'hold', holds: 1 } : { action: 'dispatch', holds: 0 }
}

/** `live`: descriptions of every `started` `HostedTask`, plus `<agent>
 *  #<n>` for a `recent` record still at `sent` — without the latter, a
 *  sweep that happens before this turn's own `task_started` arrives would
 *  close a just-allowed row at ~0s. `completed`: descriptions whose newest
 *  task (by `startedAt`) is `completed` and that are not already in `live`. */
export function budgetLiveSets(tasks: readonly HostedTask[], recent: readonly DispatchRecord[]): { readonly live: readonly string[]; readonly completed: readonly string[] } {
  const sentDescriptions = recent.filter((r) => r.state === 'sent').map((r) => `${r.agent} #${String(r.number)}`)
  const live = [...new Set([...tasks.filter((t) => t.status === 'started').map((t) => t.description), ...sentDescriptions])]
  const liveSet = new Set(live)

  const newestByDescription = new Map<string, HostedTask>()
  for (const task of tasks) {
    const existing = newestByDescription.get(task.description)
    if (existing === undefined || Date.parse(task.startedAt) > Date.parse(existing.startedAt)) newestByDescription.set(task.description, task)
  }
  const completed = [...newestByDescription.values()].filter((t) => t.status === 'completed' && !liveSet.has(t.description)).map((t) => t.description)

  return { live, completed }
}

/** `## Pipeline Escalation`'s body — `line` is the script's own `exceeded`
 *  line (already names the ceiling and the consumed wall-clock), carried
 *  verbatim rather than re-derived. */
export function escalationBody(line: string): string {
  return `## Pipeline Escalation\n${line}\nThis app's dispatcher stopped here instead of dispatching. Raise \`budget.wallClockMinutes\`, or take the ticket over by hand.`
}

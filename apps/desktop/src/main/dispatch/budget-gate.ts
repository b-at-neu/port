// The budget gate: reset, sweep, dispatch and report over the app's own gh and git. Never throws, and an unreadable ledger holds dispatch rather than proceeding blind.
import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'
import { readAtDefaultRef } from '@/main/repos/config/harness'
import { CONFIG_PATH } from '@/main/repos/config/paths'
import { BUDGET_SESSION } from '@/main/dispatch/budget'
import type { GitHubReadContext, LedgerWriteContext, TrackerContext } from '@/main/github/context'
import { issueForPr } from '@/main/github/ledger-read'
import { writeLedger } from '@/main/github/writes/ledger-comment'
import {
  allowLine,
  ceilingSecondsFrom,
  closeRows,
  exceededLine,
  holdLine,
  renderLedger,
  renderSessionLog,
  parseSessionLog,
  renderTickClause,
  reportLedger,
  sessionLogName,
  sessionTotals,
  verdict,
} from '@/main/github/budget-ledger'
import type { LedgerRow, SessionRow, TicketTotal } from '@/main/github/budget-ledger'
import type { ReadyEntry } from '@/types/actions'
import type { BudgetCheckResult, BudgetGateFailure, BudgetReportResult, BudgetResetResult, BudgetSweepResult } from '@/types/dispatch'
import type { TickActionable } from '@/types/tick'

export type BudgetContext = Pick<Platform, 'git' | 'fs' | 'clock' | 'paths'> & GitHubReadContext & LedgerWriteContext & TrackerContext

type Ceiling = { readonly ok: true; readonly ceilingSeconds: number | null } | BudgetGateFailure
type SessionLog = { readonly ok: true; readonly rows: readonly SessionRow[] } | BudgetGateFailure
type Flush = { readonly rows: readonly SessionRow[]; readonly tickets: readonly TicketTotal[]; readonly failures: readonly string[] }
type Closed = { readonly ok: true; readonly flush: Flush; readonly stillOpen: readonly SessionRow[]; readonly nowMs: number } | BudgetGateFailure

const failed = (message: string): BudgetGateFailure => ({ ok: false, kind: 'failed', message })

const unavailable = (reason: string): BudgetGateFailure => ({
  ok: false,
  kind: 'unavailable',
  message: `the budget ceiling can't be read (${reason}). Fix it in .claude/port.config.json, or release dispatch to hand it back to the cockpit.`,
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Reads first, so a concurrent write never clobbers rows not just produced. `null` on an unreadable or unwritable ledger. */
async function appendToLedger(ctx: BudgetContext, entry: ReadyEntry, issue: number, row: LedgerRow, ceilingSeconds: number | null): Promise<readonly LedgerRow[] | null> {
  const existing = await ctx.tracker.readLedger({ owner: entry.config.owner, name: entry.config.name, issue })
  if (!existing.ok) return null
  const rows = [...existing.rows, row]
  const written = await writeLedger(ctx, { repo: entry.config.repo, issue, ref: existing.ref, body: renderLedger(rows, ceilingSeconds), scratchDir: ctx.paths.temp })
  return written.ok ? rows : null
}

/** From the default ref, the same ref every other `commands.*` and config read resolves from. */
async function resolveCeiling(ctx: BudgetContext, entry: ReadyEntry): Promise<Ceiling> {
  const read = await readAtDefaultRef(ctx, entry.path, CONFIG_PATH)
  if (!read.ok) return unavailable(read.message)
  let cfg: unknown
  try {
    cfg = JSON.parse(read.text)
  } catch {
    return unavailable(`${CONFIG_PATH} does not parse`)
  }
  const ceiling = ceilingSecondsFrom(cfg)
  if (!ceiling.ok) return unavailable(`budget.wallClockMinutes is ${ceiling.offending} — it must be a positive integer, or null for no ceiling`)
  return { ok: true, ceilingSeconds: ceiling.ceilingSeconds }
}

// The shared file name with the script: pending rows left by the subprocess era still flush.
function sessionLogPath(entry: ReadyEntry): string {
  return pathOps.join(entry.path, '.temp', sessionLogName(BUDGET_SESSION) ?? 'budget-session-desktop.tsv')
}

async function readSessionLog(ctx: BudgetContext, entry: ReadyEntry): Promise<SessionLog> {
  const read = await ctx.fs.readText(sessionLogPath(entry))
  if (read.ok) return { ok: true, rows: parseSessionLog(read.value) }
  // Anything but a missing file is a failure: reading it as empty would leave open rows never closing.
  if (read.kind === 'not-found') return { ok: true, rows: [] }
  return failed(`the budget session log can't be read (${read.message})`)
}

async function writeSessionLog(ctx: BudgetContext, entry: ReadyEntry, rows: readonly SessionRow[]): Promise<BudgetGateFailure | null> {
  const path = sessionLogPath(entry)
  const dir = await ctx.fs.ensureDir(pathOps.dirname(path))
  if (!dir.ok) return failed(`the budget session log can't be written (${dir.message})`)
  const written = await ctx.fs.writeText(path, renderSessionLog(rows))
  return written.ok ? null : failed(`the budget session log can't be written (${written.message})`)
}

/** Promotes each flushed `pending` row to `closed` and leaves a failure `pending` to retry. */
async function flushPending(ctx: BudgetContext, entry: ReadyEntry, rows: readonly SessionRow[], ceilingSeconds: number | null): Promise<Flush> {
  const tickets = new Map<number, TicketTotal>()
  const out: SessionRow[] = []
  const failures: string[] = []
  for (const row of rows) {
    if (row.state !== 'pending') {
      out.push(row)
      continue
    }
    const ledger = await appendToLedger(ctx, entry, row.issue, { stage: row.stage, model: row.model, startedAt: row.startedAt, seconds: row.seconds, outcome: row.outcome }, ceilingSeconds)
    if (ledger === null) {
      failures.push(`#${String(row.issue)}: could not flush its ${row.stage} dispatch to the ledger — keeping the row for the next sweep`)
      out.push(row)
      continue
    }
    out.push({ ...row, state: 'closed' })
    tickets.set(row.issue, { issue: row.issue, secondsUsed: ledger.reduce((acc, r) => acc + r.seconds, 0), ceilingSeconds })
  }
  return { rows: out, tickets: [...tickets.values()], failures }
}

/** `reset` and `sweep` are one operation over different live sets: close every open row the caller no longer vouches for, then flush. */
async function closeAndFlush(ctx: BudgetContext, entry: ReadyEntry, live: readonly string[], completed: readonly string[]): Promise<Closed> {
  const ceiling = await resolveCeiling(ctx, entry)
  if (!ceiling.ok) return ceiling
  const log = await readSessionLog(ctx, entry)
  if (!log.ok) return log
  const nowMs = ctx.clock.now().getTime()
  const { closed, stillOpen } = closeRows(
    log.rows.filter((r) => r.state === 'open'),
    live,
    nowMs,
    completed,
  )
  const flush = await flushPending(ctx, entry, [...log.rows.filter((r) => r.state !== 'open'), ...closed], ceiling.ceilingSeconds)
  return { ok: true, flush, stillOpen, nowMs }
}

async function reset(ctx: BudgetContext, entry: ReadyEntry): Promise<BudgetResetResult> {
  const closed = await closeAndFlush(ctx, entry, [], [])
  if (!closed.ok) return closed
  // Dropping every flushed row *is* the session scoping; a row whose ledger write failed stays `pending`, so a blip at startup discards nothing.
  const written = await writeSessionLog(
    ctx,
    entry,
    closed.flush.rows.filter((r) => r.state === 'pending'),
  )
  if (written !== null) return written
  const [firstFailure] = closed.flush.failures
  return firstFailure === undefined ? { ok: true } : failed(firstFailure)
}

async function sweep(ctx: BudgetContext, entry: ReadyEntry, sets: { readonly live: readonly string[]; readonly completed: readonly string[] }): Promise<BudgetSweepResult> {
  const closed = await closeAndFlush(ctx, entry, sets.live, sets.completed)
  if (!closed.ok) return { line: null, problem: closed.message }
  const all = [...closed.stillOpen, ...closed.flush.rows]
  const written = await writeSessionLog(ctx, entry, all)
  const clause = all.length === 0 ? null : renderTickClause(sessionTotals(all, closed.nowMs), closed.flush.tickets).replace(/^\*\*Budget:\*\* /, '')
  return { line: clause, problem: written?.message ?? closed.flush.failures[0] ?? null }
}

async function check(ctx: BudgetContext, entry: ReadyEntry, candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'>, model: string): Promise<BudgetCheckResult> {
  const ceiling = await resolveCeiling(ctx, entry)
  if (!ceiling.ok) return ceiling
  const { ceilingSeconds } = ceiling

  let issue = candidate.number
  if (candidate.kind !== 'issue') {
    const resolved = await issueForPr(ctx, { repo: entry.config.repo, pr: candidate.number })
    if (!resolved.ok) return failed(resolved.why)
    issue = resolved.issue
  }

  const ledger = await ctx.tracker.readLedger({ owner: entry.config.owner, name: entry.config.name, issue })
  if (!ledger.ok) return { ok: true, verdict: 'hold', line: holdLine(issue, ledger.why) }

  const secondsUsed = ledger.seconds
  if (verdict({ secondsUsed, ceilingSeconds }) === 'exceeded') {
    return { ok: true, verdict: 'exceeded', line: exceededLine(issue, secondsUsed, ceilingSeconds, candidate.agent) }
  }

  // This row's clock starts here — the reason the dispatcher runs the gate last.
  const log = await readSessionLog(ctx, entry)
  if (!log.ok) return log
  const row: SessionRow = { issue, dispatchNumber: candidate.number, stage: candidate.agent, model, startedAt: ctx.clock.now().toISOString(), state: 'open', seconds: 0, outcome: '' }
  const written = await writeSessionLog(ctx, entry, [...log.rows, row])
  // A dispatch that could not be metered must not go out.
  if (written !== null) return written
  return { ok: true, verdict: 'allow', line: allowLine(issue, secondsUsed, ceilingSeconds) }
}

async function report(ctx: BudgetContext, entry: ReadyEntry, issue: number): Promise<BudgetReportResult> {
  const ceiling = await resolveCeiling(ctx, entry)
  if (!ceiling.ok) return ceiling
  const ledger = await ctx.tracker.readLedger({ owner: entry.config.owner, name: entry.config.name, issue })
  if (!ledger.ok) return failed(`could not read #${String(issue)}'s cost ledger: ${ledger.why}`)
  return { ok: true, ...reportLedger(ledger.rows, ceiling.ceilingSeconds) }
}

export const budgetReset = (ctx: BudgetContext, entry: ReadyEntry): Promise<BudgetResetResult> => reset(ctx, entry).catch((error: unknown): BudgetGateFailure => failed(messageOf(error)))

export const budgetSweep = (ctx: BudgetContext, entry: ReadyEntry, sets: { readonly live: readonly string[]; readonly completed: readonly string[] }): Promise<BudgetSweepResult> =>
  sweep(ctx, entry, sets).catch((error: unknown): BudgetSweepResult => ({ line: null, problem: messageOf(error) }))

export const budgetCheck = (ctx: BudgetContext, entry: ReadyEntry, candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'>, model: string): Promise<BudgetCheckResult> =>
  check(ctx, entry, candidate, model).catch((error: unknown): BudgetGateFailure => failed(messageOf(error)))

export const budgetReport = (ctx: BudgetContext, entry: ReadyEntry, issue: number): Promise<BudgetReportResult> => report(ctx, entry, issue).catch((error: unknown): BudgetGateFailure => failed(messageOf(error)))

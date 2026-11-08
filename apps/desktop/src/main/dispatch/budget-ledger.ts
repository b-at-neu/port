// Pure port of bin/budget.mjs's ledger, session-log, and verdict logic — byte-compatible, since a terminal cockpit and this app can write the same comment. No value imports: the layer 1 parity check loads this file directly under Node.
import type { CeilingResult, ComputedVerdict, LedgerRow, SessionRow, TicketTotal } from '@/types/budget'

/** Whole seconds since `startedAt`, 0 for an unparseable one, which contributes nothing but is still closed. */
function elapsed(startedAt: string, nowMs: number): number {
  const startedMs = Date.parse(startedAt)
  return Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0
}

/** `<m>m <ss>s` below an hour, `<h>h <mm>m` at or above one. Never parsed back. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.trunc(totalSeconds || 0))
  if (s >= 3600) return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${String(Math.floor(s / 60))}m ${String(s % 60).padStart(2, '0')}s`
}

export function verdict(params: { readonly secondsUsed: number; readonly ceilingSeconds: number | null }): ComputedVerdict {
  if (params.ceilingSeconds === null) return 'allow'
  return params.secondsUsed >= params.ceilingSeconds ? 'exceeded' : 'allow'
}

/** `null` when the table does not parse — a malformed ledger is absent, never zero. */
export function parseLedger(markdown: string): { readonly rows: readonly LedgerRow[] } | null {
  if (!/^##\s*Pipeline Cost\s*$/m.test(markdown)) return null
  const lines = markdown.split('\n')
  const headerIdx = lines.findIndex((l) => /^\|\s*Stage\s*\|\s*Model\s*\|\s*Started/i.test(l))
  if (headerIdx === -1) return null
  if (!/^\|[\s:-]+\|/.test(lines[headerIdx + 1] ?? '')) return null
  const rows: LedgerRow[] = []
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim().startsWith('|')) break
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    const [stage, model, startedAt, secondsStr, outcome] = cells
    if (cells.length < 5 || stage === undefined || model === undefined || startedAt === undefined || secondsStr === undefined || outcome === undefined) return null
    const seconds = Number(secondsStr)
    if (!Number.isInteger(seconds) || seconds < 0) return null
    rows.push({ stage, model, startedAt, seconds, outcome })
  }
  return { rows }
}

export function renderLedger(rows: readonly LedgerRow[], ceilingSeconds: number | null): string {
  const total = rows.reduce((acc, r) => acc + r.seconds, 0)
  const noun = rows.length === 1 ? 'dispatch' : 'dispatches'
  const head = `**Total:** ${String(rows.length)} ${noun} · ${String(total)}s (${formatDuration(total)})`
  const tail =
    ceilingSeconds === null
      ? `${head} — no ceiling configured`
      : `${head} of ${String(ceilingSeconds)}s (${String(Math.round(ceilingSeconds / 60))}m) — ${String(Math.round((total / ceilingSeconds) * 100))}%`
  const body = rows.map((r) => `| ${r.stage} | ${r.model} | ${r.startedAt} | ${String(r.seconds)} | ${r.outcome} |`)
  const header = ['## Pipeline Cost', '', '| Stage | Model | Started (UTC) | Seconds | Outcome |', '| --- | --- | --- | --- | --- |']
  return [...header, ...body, '', tail].join('\n')
}

/** An entry that does not match `"<stage> #<n>"` comes back in `invalid`, treated as not live. */
export function parseDescriptionList(raw: string): { readonly descriptions: readonly string[]; readonly invalid: readonly string[] } {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const wellFormed = (e: string): boolean => /^[a-z]+ #\d+$/.test(e)
  return { descriptions: entries.filter(wellFormed), invalid: entries.filter((e) => !wellFormed(e)) }
}

/** Closes every open row absent from `liveDescriptions`; one named in `completedDescriptions` closes `completed`, anything else `lost`. */
export function closeRows(
  openRows: readonly SessionRow[],
  liveDescriptions: readonly string[],
  nowMs: number,
  completedDescriptions: readonly string[] = [],
): { readonly stillOpen: readonly SessionRow[]; readonly closed: readonly SessionRow[] } {
  const live = new Set(liveDescriptions)
  const done = new Set(completedDescriptions)
  const desc = (row: SessionRow): string => `${row.stage} #${String(row.dispatchNumber)}`
  return {
    stillOpen: openRows.filter((row) => live.has(desc(row))),
    closed: openRows
      .filter((row) => !live.has(desc(row)))
      .map((row): SessionRow => ({ ...row, seconds: elapsed(row.startedAt, nowMs), outcome: done.has(desc(row)) ? 'completed' : 'lost', state: 'pending' })),
  }
}

/** The same `Closes #N` grammar `bin/artifacts.mjs`'s `checkPrBody` validates. */
export function issueFromPrBody(body: string): number | null {
  const m = /^Closes #(\d+)$/.exec(body.split('\n')[0]?.trim() ?? '')
  return m?.[1] === undefined ? null : Number(m[1])
}

/** Absent (`undefined`/`null`) is unbounded; anything else malformed is fatal, never read as "no ceiling". */
export function ceilingSecondsFrom(cfg: unknown): CeilingResult {
  const budget = (cfg as { readonly budget?: { readonly wallClockMinutes?: unknown } } | null | undefined)?.budget
  const minutes = budget?.wallClockMinutes
  if (minutes === undefined || minutes === null) return { ok: true, ceilingSeconds: null }
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1) return { ok: false, offending: JSON.stringify(minutes) }
  return { ok: true, ceilingSeconds: minutes * 60 }
}

/** Tab-separated: issue, stage, model, startedAt, state, seconds, outcome, dispatchNumber. An unknown state reads as `open`. */
export function parseSessionLog(text: string): readonly SessionRow[] {
  const rows: SessionRow[] = []
  for (const line of text.split('\n')) {
    const [issue, stage, model, startedAt, state, seconds, outcome, dispatch] = line.split('\t')
    if (!line.trim() || !issue || !stage || !model || !startedAt) continue
    const secs = Number(seconds)
    const dn = Number(dispatch)
    rows.push({
      issue: Number(issue),
      dispatchNumber: Number.isInteger(dn) && dn > 0 ? dn : Number(issue),
      stage,
      model,
      startedAt,
      state: state === 'pending' || state === 'closed' ? state : 'open',
      seconds: Number.isInteger(secs) && secs >= 0 ? secs : 0,
      outcome: outcome || 'lost',
    })
  }
  return rows
}

export function renderSessionLog(rows: readonly SessionRow[]): string {
  const line = (r: SessionRow): string => [r.issue, r.stage, r.model, r.startedAt, r.state, r.seconds, r.outcome, r.dispatchNumber].join('\t')
  return rows.length > 0 ? `${rows.map(line).join('\n')}\n` : ''
}

/** From the local log alone — no GitHub I/O, so the tick clause is producible every tick. */
export function sessionTotals(rows: readonly SessionRow[], nowMs: number): { readonly dispatches: number; readonly seconds: number } {
  const seconds = rows.reduce((acc, r) => acc + (r.state === 'open' ? elapsed(r.startedAt, nowMs) : r.seconds), 0)
  return { dispatches: rows.length, seconds }
}

/** The session half always prints; a per-ticket half is appended only for a ledger this sweep actually read. */
export function renderTickClause(totals: { readonly dispatches: number; readonly seconds: number }, tickets: readonly TicketTotal[]): string {
  const noun = totals.dispatches === 1 ? 'dispatch' : 'dispatches'
  const per = (t: TicketTotal): string =>
    t.ceilingSeconds === null
      ? `#${String(t.issue)} at ${formatDuration(t.secondsUsed)}, no ceiling configured`
      : `#${String(t.issue)} at ${formatDuration(t.secondsUsed)} of its ${String(Math.round(t.ceilingSeconds / 60))}m ceiling (${String(Math.round((t.secondsUsed / t.ceilingSeconds) * 100))}%)`
  const parts = [`session ${String(totals.dispatches)} ${noun}`, `${formatDuration(totals.seconds)} agent wall-clock`, ...tickets.map(per)]
  return `**Budget:** ${parts.join(' · ')}`
}

/** `undefined` → the shared log's name; a well-formed name → its own file; anything else → `null`. */
export function sessionLogName(session: string | undefined): string | null {
  if (session === undefined) return 'budget-session.tsv'
  return /^[a-z][a-z0-9-]{0,31}$/.test(session) ? `budget-session-${session}.tsv` : null
}

export function holdLine(issue: number, why: string): string {
  return `⏳ Couldn't read #${String(issue)}'s cost ledger (${why}) — holding its dispatch one tick rather than dispatching blind.`
}

export function exceededLine(issue: number, secondsUsed: number, ceilingSeconds: number | null, stage: string): string {
  return `⛔ #${String(issue)} has consumed ${formatDuration(secondsUsed)} of agent wall-clock against a ${String(Math.round((ceilingSeconds ?? 0) / 60))}m ceiling — escalate instead of dispatching ${stage} #${String(issue)}.`
}

export function allowLine(issue: number, secondsUsed: number, ceilingSeconds: number | null): string {
  const used = `✅ #${String(issue)} dispatch allowed — ${formatDuration(secondsUsed)}`
  return ceilingSeconds === null ? `${used} of agent wall-clock so far, no ceiling configured.` : `${used} of its ${String(Math.round(ceilingSeconds / 60))}m ceiling used.`
}

/** The pure half of `report`: the rendered ledger and its verdict. */
export function reportLedger(rows: readonly LedgerRow[], ceilingSeconds: number | null): { readonly markdown: string; readonly verdict: ComputedVerdict } {
  const secondsUsed = rows.reduce((acc, r) => acc + r.seconds, 0)
  return { markdown: renderLedger(rows, ceilingSeconds), verdict: verdict({ secondsUsed, ceilingSeconds }) }
}

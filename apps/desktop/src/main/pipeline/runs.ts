// Pure: the run half of the transition table, the projections over `Ticket.runs`, boot recovery and the unmatched-claim ladder. No I/O.
import { inFlightKeyFor } from '@/main/pipeline/tick/routing'
import { SOURCE_BASE_INTERVAL_MS } from '@/types/board'
import type { StageRecord } from '@/types/dispatch'
import type { InterruptedStage, StageDenial } from '@/types/stage'
import type { RunChange, RunEvent, TableResult } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import { NETWORK_BACKOFF_MS, RUN_CAP, type Run, type Stage, type Ticket } from '@/utils/pipeline/ticket'

const MOVED: TableResult = { ok: false, reason: 'moved' }
const DENIAL_LIMIT = 20

/** A run whose session may still be going: launched, not interrupted, and not past a final outcome. */
export function isOpen(run: Run): boolean {
  return run.worktree !== null && run.interruption === null && (run.outcome === null || run.outcome === 'questions' || run.outcome === 'blocked')
}

function outcomeFields(run: Run, outcome: StageOutcome): Run {
  return { ...run, outcome: outcome.kind, handback: outcome.handback, costUsd: outcome.costUsd ?? run.costUsd, failure: outcome.detail }
}

function interrupt(run: Run, change: Extract<RunChange, { kind: 'interrupted' }>, at: string): Run {
  const base = change.outcome === null ? run : outcomeFields(run, change.outcome)
  const retries = change.reason === 'network' ? run.networkRetries : 0
  const backoff = NETWORK_BACKOFF_MS[Math.min(retries, NETWORK_BACKOFF_MS.length - 1)] ?? 0
  const resetsAt = change.reason === 'network' ? new Date(Date.parse(at) + backoff).toISOString() : change.resetsAt
  return { ...base, costUsd: change.costUsd ?? base.costUsd, endedAt: run.endedAt ?? at, networkRetries: retries, interruption: { reason: change.reason, detail: change.detail, at, resetsAt } }
}

/** The run after `change`, or the same object when nothing changes. */
function changed(run: Run, change: RunChange, at: string): Run {
  switch (change.kind) {
    case 'session':
      return run.claudeSessionId === null ? { ...run, claudeSessionId: change.claudeSessionId } : run
    case 'joined':
      return run.operatorJoinedAt === null ? { ...run, operatorJoinedAt: change.at } : run
    case 'handback':
      return outcomeFields(run, change.outcome)
    case 'ended': {
      const ended = change.outcome === null ? run : outcomeFields(run, change.outcome)
      return { ...ended, endedAt: run.endedAt ?? at }
    }
    case 'interrupted':
      return interrupt(run, change, at)
    case 'quit':
      return isOpen(run) ? interrupt(run, { kind: 'interrupted', reason: 'quit', detail: null, resetsAt: null, costUsd: null, outcome: null }, at) : run
    case 'resumed':
      return { ...run, sessionKey: change.sessionKey, endedAt: null, interruption: null, outcome: null, handback: null, failure: null, networkRetries: run.interruption?.reason === 'network' ? run.networkRetries + 1 : run.networkRetries }
    case 'cleared': {
      if (run.interruption === null) return run
      const open = run.outcome === null || run.outcome === 'questions' || run.outcome === 'blocked'
      return { ...run, interruption: null, endedAt: run.endedAt ?? at, outcome: open ? 'interrupted' : run.outcome }
    }
    case 'denied':
      return { ...run, denials: [...run.denials.filter((d) => d.rule !== change.denial.rule), change.denial].slice(-DENIAL_LIMIT) }
    case 'denial-dismissed':
      return run.denials.some((d) => d.id === change.id) ? { ...run, denials: run.denials.filter((d) => d.id !== change.id) } : run
    case 'denials-cleared':
      return run.denials.some((d) => d.rule === change.rule) ? { ...run, denials: run.denials.filter((d) => d.rule !== change.rule) } : run
  }
}

/** Keeps the newest `RUN_CAP` runs; an open or interrupted run is never dropped. */
export function capped(runs: Run[]): Run[] {
  let excess = runs.length - RUN_CAP
  if (excess <= 0) return runs
  return runs.filter((run) => {
    if (excess > 0 && run.interruption === null && !isOpen(run)) {
      excess -= 1
      return false
    }
    return true
  })
}

/** A run binds its ticket's `running` status when the claim left it unbound at the run's stage. */
function binds(ticket: Ticket, run: Run): boolean {
  return run.endedAt === null && ticket.stage === run.stage && ticket.status.kind === 'running' && ticket.status.runId === null
}

function withRuns(ticket: Ticket, runs: Run[], run: Run | null): Ticket {
  if (run === null || !binds(ticket, run)) return { ...ticket, runs }
  return { ...ticket, rev: ticket.rev + 1, status: { kind: 'running', runId: run.id }, runs }
}

/** The run events of the table. None writes a history row, and only binding `status.runId` bumps `rev`. */
export function applyRunChange(ticket: Ticket, event: RunEvent, at: string): TableResult {
  if (event.kind === 'run-start') {
    const runs = capped([...ticket.runs.filter((run) => run.id !== event.run.id), event.run])
    return { ok: true, changed: true, ticket: withRuns(ticket, runs, event.run) }
  }
  const run = ticket.runs.find((candidate) => candidate.id === event.runId)
  if (run === undefined) return MOVED
  const next = changed(run, event.change, at)
  if (next === run) return { ok: true, ticket, changed: false }
  const runs = ticket.runs.map((candidate) => (candidate === run ? next : candidate))
  return { ok: true, changed: true, ticket: withRuns(ticket, runs, event.change.kind === 'resumed' ? next : null) }
}

export function ticketOfRun(tickets: readonly Ticket[], runId: string): Ticket | null {
  return tickets.find((ticket) => ticket.runs.some((run) => run.id === runId)) ?? null
}

export function interruptedOf(ticket: Ticket, run: Run): InterruptedStage | null {
  if (run.worktree === null) return null
  return {
    id: run.id,
    repoId: ticket.repo,
    agent: run.agent,
    number: run.item.number,
    kind: run.item.kind,
    trigger: run.trigger,
    inFlight: inFlightKeyFor(run.agent, run.trigger),
    model: run.model,
    ...(run.title === null ? {} : { title: run.title }),
    claudeSessionId: run.claudeSessionId,
    worktree: run.worktree,
    startedAt: run.startedAt,
    interruptedAt: run.interruption?.at ?? run.startedAt,
    reason: run.interruption?.reason ?? 'crash',
    detail: run.interruption?.detail ?? null,
    resetsAt: run.interruption?.resetsAt ?? null,
    costUsd: run.costUsd,
    networkRetries: run.networkRetries,
  }
}

export function interruptedRuns(tickets: readonly Ticket[]): readonly InterruptedStage[] {
  return tickets.flatMap((ticket) => ticket.runs.filter((run) => run.interruption !== null).flatMap((run) => interruptedOf(ticket, run) ?? []))
}

export function openRuns(tickets: readonly Ticket[]): readonly InterruptedStage[] {
  return tickets.flatMap((ticket) => ticket.runs.filter(isOpen).flatMap((run) => interruptedOf(ticket, run) ?? []))
}

/** Newest per rule, the last `DENIAL_LIMIT` of them, oldest first. */
export function denialsOf(tickets: readonly Ticket[]): readonly StageDenial[] {
  const all = tickets.flatMap((ticket) =>
    ticket.runs.flatMap((run) => run.denials.map((denial): StageDenial => ({ id: denial.id, repoId: ticket.repo, agent: run.agent, number: run.item.number, toolName: denial.toolName, inputSummary: denial.inputSummary, rule: denial.rule, at: denial.at, sessionKey: run.sessionKey }))),
  )
  const newest = all.filter((denial) => !all.some((other) => other.rule === denial.rule && other.at > denial.at))
  return newest.sort((a, b) => a.at.localeCompare(b.at)).slice(-DENIAL_LIMIT)
}

/** The outcome a run's own fields stand for; an interruption with none recorded reads as `interrupted`, and `null` means the run is still undecided. */
export function outcomeOf(run: Run): StageOutcome | null {
  const kind = run.outcome ?? (run.interruption === null ? null : 'interrupted')
  if (kind === null) return null
  return { kind, detail: run.failure, costUsd: run.costUsd, resetsAt: run.interruption?.resetsAt ?? null, worktree: run.outcome === 'completed' ? 'removed' : 'kept', operatorJoined: run.operatorJoinedAt !== null, handback: run.handback }
}

export function dispatchRecordOf(run: Run): StageRecord {
  const failed = run.worktree === null && run.failure !== null
  return {
    runId: run.id,
    sessionKey: run.sessionKey,
    agent: run.agent,
    number: run.item.number,
    kind: run.item.kind,
    trigger: run.trigger,
    state: failed ? 'failed' : run.endedAt === null ? 'started' : 'ended',
    at: run.startedAt,
    endedAt: failed ? null : run.endedAt,
    detail: failed ? run.failure : null,
    outcome: failed ? null : outcomeOf(run),
    claudeSessionId: run.claudeSessionId,
    operatorJoinedAt: run.operatorJoinedAt,
  }
}

export interface RecoveredRuns {
  readonly changes: readonly { readonly repo: Ticket['repo']; readonly ticket: number; readonly runId: string; readonly change: RunChange }[]
  readonly replays: readonly { readonly ticket: Ticket; readonly run: Run }[]
}

/** What a restart makes of the runs on disk: a run open at boot lost its process and is `crash`; a finished hand-back whose label write never landed is replayed, unless it carried a plan file that went with its worktree. */
export function recoverRuns(tickets: readonly Ticket[]): RecoveredRuns {
  const changes: RecoveredRuns['changes'][number][] = []
  const replays: RecoveredRuns['replays'][number][] = []
  for (const ticket of tickets) {
    for (const run of ticket.runs) {
      if (isOpen(run)) changes.push({ repo: ticket.repo, ticket: ticket.ticket, runId: run.id, change: { kind: 'interrupted', reason: 'crash', detail: null, resetsAt: null, costUsd: null, outcome: null } })
      const unwritten = run.outcome === 'completed' && run.handback !== null && run.handback.token !== 'plan-written' && run.sessionKey !== null
      if (unwritten && ticket.status.kind === 'running' && ticket.status.runId === run.id) replays.push({ ticket, run })
    }
  }
  return { changes, replays }
}

export type UnmatchedClaim = 'no-record' | 'suspect' | 'reset' | 'capped'

/** The stall ladder for a claim neither live nor interrupted, read from the runs at the claim's stage. At most one automatic reset per stage visit; finished work (a hand-back) is never reset. */
export function unmatchedClaimOf(runs: readonly Run[], stage: Stage, readAt: string | null): UnmatchedClaim {
  const launched = runs.filter((run) => run.sessionKey !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const other = launched.findIndex((run) => run.stage !== stage)
  const visit = other === -1 ? launched : launched.slice(0, other)
  const [newest] = visit
  if (newest === undefined) return 'no-record'
  if (newest.handback !== null) return 'capped'
  if (newest.endedAt === null || readAt === null || Date.parse(readAt) < Date.parse(newest.endedAt) + SOURCE_BASE_INTERVAL_MS.github) return 'suspect'
  return visit.filter((run) => run.endedAt !== null && run.handback === null).length === 1 ? 'reset' : 'capped'
}

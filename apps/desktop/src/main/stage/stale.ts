// Pure decisions for the interrupted-entry sweeper: which entries moved on, and which usage-limit ones may resume.
// Every rule fails toward keeping an entry — a wrongly kept row costs a glance, a wrongly cleared one hides work.
import { RUN_TARGET } from '@/types/dispatch'
import type { DispatchRecord, RepoDispatchStatus } from '@/types/dispatch'
import type { ItemsByNumberFetch } from '@/types/github'
import type { RepositoryState } from '@/types/state'
import type { InterruptedStage } from '@/types/stage'

/** Past `resetsAt`, a usage-limit entry waits this long more before it resumes on its own. */
export const AUTO_RESUME_GRACE_MS = 60_000

export interface StaleVerdict {
  /** Registry ids that have moved on. */
  readonly clear: readonly string[]
  /** Numbers the open-only sweep no longer returns — the caller resolves them with one `fetchItemsByNumber`. */
  readonly recheck: readonly number[]
}

interface StaleInput {
  /** One repository's own interrupted entries. */
  readonly entries: readonly InterruptedStage[]
  readonly repo: RepositoryState
  readonly recent: readonly DispatchRecord[]
}

function instantOf(value: string): number {
  return Date.parse(value)
}

function sameTicket(a: Pick<InterruptedStage, 'kind' | 'number'>, b: Pick<InterruptedStage, 'kind' | 'number'>): boolean {
  return a.kind === b.kind && a.number === b.number
}

/** A dispatch record newer than the interruption means the ticket was launched again; a `failed` record never created a session. */
function hasNewerSession(entry: InterruptedStage, recent: readonly DispatchRecord[]): boolean {
  const since = instantOf(entry.interruptedAt)
  return recent.some((r) => r.state !== 'failed' && sameTicket(r, entry) && instantOf(r.at) > since)
}

/** Only the newest entry of a ticket survives; a tie keeps the later one in list order. */
function isSupersededByEntry(entry: InterruptedStage, index: number, entries: readonly InterruptedStage[]): boolean {
  const at = instantOf(entry.interruptedAt)
  return entries.some((other, otherIndex) => {
    if (otherIndex === index || !sameTicket(other, entry)) return false
    const otherAt = instantOf(other.interruptedAt)
    return otherAt > at || (otherAt === at && otherIndex > index)
  })
}

/** The repository's GitHub read is trustworthy for this entry only when it is complete and was taken after the interruption. */
function cleanReadAfter(repo: RepositoryState, interruptedAt: string): repo is Extract<RepositoryState, { readonly ok: true }> {
  if (!repo.ok || repo.unavailable.length > 0 || repo.truncated.length > 0) return false
  const github = repo.freshness.github
  return 'at' in github && instantOf(github.at) >= instantOf(interruptedAt)
}

/** `staleInterrupted({ entries, repo, recent })` — a blind, partial or too-old read clears nothing and rechecks nothing. */
export function staleInterrupted(input: StaleInput): StaleVerdict {
  const clear: string[] = []
  const recheck = new Set<number>()

  input.entries.forEach((entry, index) => {
    if (hasNewerSession(entry, input.recent) || isSupersededByEntry(entry, index, input.entries)) {
      clear.push(entry.id)
      return
    }
    const repo = input.repo
    if (!cleanReadAfter(repo, entry.interruptedAt)) return
    const item = repo.items.find((candidate) => candidate.kind === entry.kind && candidate.number === entry.number)
    if (item === undefined) recheck.add(entry.number)
    else if (!item.matchedKeys.includes(entry.inFlight)) clear.push(entry.id)
  })

  return { clear, recheck: [...recheck] }
}

/** `clearedByRecheck(entries, fetch)` — a number the live read resolves is merged, closed, or open outside the label sweep (so not in flight); all three clear. A failed read or an unresolvable number keeps the entry. */
export function clearedByRecheck(entries: readonly InterruptedStage[], fetch: ItemsByNumberFetch): readonly string[] {
  if (!fetch.ok) return []
  const resolved = new Set(fetch.resolved.map((item) => item.number))
  return entries.filter((entry) => resolved.has(entry.number) && !fetch.unavailable.includes(entry.number)).map((entry) => entry.id)
}

function mayAutoLaunch(status: readonly RepoDispatchStatus[], repoId: InterruptedStage['repoId']): boolean {
  const repo = status.find((s) => s.repoId === repoId)
  return repo !== undefined && repo.owner === 'app' && repo.runState === RUN_TARGET.run
}

/** `autoResumable(entries, now, status)` — usage-limit entries past their reset whose repository this app owns and is running, oldest interruption first. A paused, draining or terminal-owned repository never launches. */
export function autoResumable(entries: readonly InterruptedStage[], now: Date, status: readonly RepoDispatchStatus[]): readonly string[] {
  return entries
    .filter((entry) => {
      if (entry.reason !== 'usage-limit' || entry.resetsAt === null || entry.claudeSessionId === null) return false
      return instantOf(entry.resetsAt) + AUTO_RESUME_GRACE_MS <= now.getTime() && mayAutoLaunch(status, entry.repoId)
    })
    .sort((a, b) => instantOf(a.interruptedAt) - instantOf(b.interruptedAt))
    .map((entry) => entry.id)
}

// Pure "needs you" derivation, built on `projectBoard`'s own rows so
// `actions`/`decisions` availability is reused, never re-derived.
import type { BudgetNote } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { InterruptedStage, StageDenial } from '@/types/stage'
import type { RepoId } from '@/utils/repos'
import type { RepositoryState } from '@/types/state'
import type { TickHeld } from '@/types/tick'
import { projectBoard } from '@/renderer/board/project'
import type { BoardItemRow, BoardSnapshot, NeedsYouItem } from '@/types/board'
import { BLOCKED_PREFIX, classifyHandbackText } from '@/utils/stage/handback-text'

/** The four label-keyed kinds, each carrying the row they came from. */
type RowNeedsYouKind = 'plan-review' | 'ready-to-merge' | 'needs-human' | 'blocked'

// Every other stage key carries no "needs you" kind at all.
const ROW_KIND: Readonly<Partial<Record<string, RowNeedsYouKind>>> = {
  planReview: 'plan-review',
  approved: 'ready-to-merge',
  needsHuman: 'needs-human',
  blocked: 'blocked',
}

// The row-level "needs you" kind for a stage label key, undefined otherwise.
export function needsYouReasonOf(stageKey: string | undefined): RowNeedsYouKind | undefined {
  return ROW_KIND[stageKey ?? '']
}

/** A row is the operator's only when its stage is a gate and no auto-approval is about to clear it. */
export function waitsOnYou(row: BoardItemRow): boolean {
  return needsYouReasonOf(row.stageLabel?.key) !== undefined && !row.autoApproving
}

// A held reason outside this set is routine queueing, never something waiting on the operator.
const HELD_KINDS: ReadonlySet<TickHeld['reason']> = new Set(['conflicting', 'contended', 'cycle-cap'])

// The budget gate's other note kinds are routine; only these two ever need the operator.
const BUDGET_KINDS: ReadonlySet<BudgetNote['kind']> = new Set(['escalated', 'escalation-failed'])

function readyRepos(snapshot: BoardSnapshot): readonly Extract<RepositoryState, { readonly ok: true }>[] {
  return snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)
}

function rowKey(repoId: RepoId, number: number): string {
  return `${repoId}:${String(number)}`
}

function compareByRepoThenNumber(a: NeedsYouItem, b: NeedsYouItem, displayNameOf: ReadonlyMap<RepoId, string>): number {
  const nameA = a.repoId !== null ? (displayNameOf.get(a.repoId) ?? '') : ''
  const nameB = b.repoId !== null ? (displayNameOf.get(b.repoId) ?? '') : ''
  if (nameA !== nameB) return nameA < nameB ? -1 : 1
  return (b.number ?? 0) - (a.number ?? 0)
}

function compareItems(a: NeedsYouItem, b: NeedsYouItem, displayNameOf: ReadonlyMap<RepoId, string>): number {
  const atA = a.at !== null ? Date.parse(a.at) : null
  const atB = b.at !== null ? Date.parse(b.at) : null
  if (atA !== null && atB !== null) return atA === atB ? compareByRepoThenNumber(a, b, displayNameOf) : atB - atA
  if (atA !== null) return -1
  if (atB !== null) return 1

  return compareByRepoThenNumber(a, b, displayNameOf)
}

const STAGE_HANDBACK_TEXT_CAP = 120

function capped(text: string): string {
  return text.length > STAGE_HANDBACK_TEXT_CAP ? `${text.slice(0, STAGE_HANDBACK_TEXT_CAP)}…` : text
}

function stageHandbackText(result: HostedSessionSnapshot['lastResult']): string | null {
  if (result?.text === null || result?.text === undefined) return null
  return capped(result.text)
}

function blockedText(line: string): string {
  return capped(line.slice(BLOCKED_PREFIX.length).trim())
}

/** A denial blocks only while its own session is still open and idle after it — an ended session's denial stays on Repositories → Denials alone. */
function isBlockingDenial(denial: StageDenial, sessionByKey: ReadonlyMap<SessionKey, HostedSessionSnapshot>): boolean {
  if (denial.sessionKey === null) return false
  const session = sessionByKey.get(denial.sessionKey)
  if (session === undefined || session.phase !== 'ready' || session.lastResult === null) return false
  return Date.parse(session.lastResult.at) >= Date.parse(denial.at)
}

function latest(instants: readonly string[]): string | null {
  const parsed = instants.filter((at) => !Number.isNaN(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))
  return parsed[0] ?? null
}

/** Every usage-limit entry across repositories is one line: the sessions wait on the same reset. */
function usageLimitItem(entries: readonly InterruptedStage[], repoNames: ReadonlyMap<RepoId, string>): NeedsYouItem | null {
  if (entries.length === 0) return null
  return {
    kind: 'usage-limit',
    repoId: null,
    repo: null,
    number: null,
    title: null,
    url: null,
    ticket: null,
    at: latest(entries.map((entry) => entry.interruptedAt)),
    matchedRow: null,
    entries,
    repoNames,
    resetsAt: latest(entries.flatMap((entry) => (entry.resetsAt === null ? [] : [entry.resetsAt]))),
  }
}

/** One entry per (repoId, number, kind), newest `at` first where known, then by repo then number descending. Session and dispatch kinds keep their own event time; row kinds and held/stalled/budget/half-labelled fall back to the matched item's `updatedAt`, or `null` when there is no matched row. `sessions` is `session:list`'s own read — `[]` when the caller has none (the empty default keeps every pre-existing call site byte-identical). */
export function needsYouItems(snapshot: BoardSnapshot, now: Date, sessions: readonly HostedSessionSnapshot[] = []): readonly NeedsYouItem[] {
  const projection = projectBoard({ snapshot, groupBy: 'repo', now, sessions })
  const rows = projection.groups.flatMap((group) => group.rows)
  // Both of a ticket's numbers resolve to its one row, so a session or note on the pull request still lands on the ticket.
  const rowByKey = new Map<string, BoardItemRow>(
    rows.flatMap((row) => [row.ticket.issue, row.ticket.pullRequest].filter((member) => member !== null).map((member): [string, BoardItemRow] => [rowKey(row.item.repoId, member.number), row])),
  )
  const ticketNumberOf = (repoId: RepoId, number: number): number => rowByKey.get(rowKey(repoId, number))?.ticket.ref.number ?? number
  const viewerByRepo = new Map<RepoId, string | null>(readyRepos(snapshot).map((repo) => [repo.repoId, repo.viewer]))
  const displayNameOf = new Map<RepoId, string>(readyRepos(snapshot).map((repo) => [repo.repoId, repo.displayName]))
  const ownerByRepo = new Map(snapshot.dispatch.map((d) => [d.repoId, d.owner] as const))

  const items: NeedsYouItem[] = []

  // A live stage session with a pending AskUserQuestion never also produces a `stage-questions` item.
  const stageQuestionNumbers = new Set<string>()
  for (const session of sessions) {
    if (session.stage === null || session.repoId === null) continue
    const oldest = [...session.pendingPermissions].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
    if (oldest === undefined || oldest.interaction?.kind !== 'question') continue
    stageQuestionNumbers.add(rowKey(session.repoId, ticketNumberOf(session.repoId, session.stage.number)))
    const matched = rowByKey.get(rowKey(session.repoId, session.stage.number)) ?? null
    items.push({
      kind: 'stage-question',
      repoId: session.repoId,
      repo: matched?.item.repo ?? null,
      number: session.stage.number,
      title: matched?.item.title ?? null,
      url: matched?.item.url ?? null,
      ticket: matched?.ticket.ref ?? null,
      at: oldest.requestedAt,
      matchedRow: matched,
      sessionKey: session.sessionKey,
      permissionId: oldest.permissionId,
      questions: oldest.interaction.questions,
    })
  }

  // A blocked label on the same item is the same fact as its live session's hand-back, so only one row renders.
  const stageBlockedKeys = new Set<string>()
  for (const session of sessions) {
    if (session.stage === null || session.repoId === null || session.phase === 'ended') continue
    if (session.lastResult === null || session.lastResult.isError) continue
    const handback = classifyHandbackText(session.lastResult.text ?? '')
    const outcomeKind = handback?.kind === 'blocked' ? 'stage-blocked' : handback?.kind === 'questions' ? 'stage-questions' : null
    if (outcomeKind === null) continue
    const ticketKey = rowKey(session.repoId, ticketNumberOf(session.repoId, session.stage.number))
    if (stageQuestionNumbers.has(ticketKey)) continue
    if (outcomeKind === 'stage-blocked') stageBlockedKeys.add(ticketKey)
    const matched = rowByKey.get(rowKey(session.repoId, session.stage.number)) ?? null
    items.push({
      kind: outcomeKind,
      repoId: session.repoId,
      repo: matched?.item.repo ?? null,
      number: session.stage.number,
      title: matched?.item.title ?? null,
      url: matched?.item.url ?? null,
      ticket: matched?.ticket.ref ?? null,
      at: session.lastResult?.at ?? null,
      matchedRow: matched,
      sessionKey: session.sessionKey,
      text: handback?.kind === 'blocked' ? blockedText(handback.line) : stageHandbackText(session.lastResult),
    })
  }

  const sessionByKey = new Map(sessions.map((session) => [session.sessionKey, session] as const))
  const usageLimited: InterruptedStage[] = []

  for (const dispatch of snapshot.dispatch) {
    for (const denial of dispatch.denials) {
      if (!isBlockingDenial(denial, sessionByKey)) continue
      const matched = rowByKey.get(rowKey(dispatch.repoId, denial.number)) ?? null
      items.push({
        kind: 'stage-denial',
        repoId: dispatch.repoId,
        repo: matched?.item.repo ?? null,
        number: denial.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        ticket: matched?.ticket.ref ?? null,
        at: denial.at,
        matchedRow: matched,
        denial,
      })
    }
    for (const interrupted of dispatch.interrupted) {
      if (interrupted.reason === 'usage-limit') {
        usageLimited.push(interrupted)
        continue
      }
      const matched = rowByKey.get(rowKey(dispatch.repoId, interrupted.number)) ?? null
      items.push({
        kind: 'stage-interrupted',
        repoId: dispatch.repoId,
        repo: matched?.item.repo ?? null,
        number: interrupted.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        ticket: matched?.ticket.ref ?? null,
        at: interrupted.interruptedAt,
        matchedRow: matched,
        interrupted,
      })
    }
  }

  const usageLimit = usageLimitItem(usageLimited, displayNameOf)
  if (usageLimit !== null) items.push(usageLimit)

  for (const row of rows) {
    const kind = needsYouReasonOf(row.stageLabel?.key)
    if (kind === undefined || !waitsOnYou(row)) continue
    if (kind === 'blocked' && stageBlockedKeys.has(rowKey(row.item.repoId, row.ticket.ref.number))) continue
    const viewer = viewerByRepo.get(row.item.repoId) ?? null
    if (viewer !== null && !row.item.assignees.includes(viewer)) continue
    items.push({ kind, repoId: row.item.repoId, repo: row.item.repo, number: row.item.number, title: row.item.title, url: row.item.url, ticket: row.ticket.ref, at: row.item.updatedAt, matchedRow: row, row })
  }

  for (const report of snapshot.tick) {
    for (const held of report.held) {
      if (!HELD_KINDS.has(held.reason)) continue
      const matched = rowByKey.get(rowKey(report.repoId, held.number)) ?? null
      items.push({
        kind: 'held',
        repoId: report.repoId,
        repo: matched?.item.repo ?? report.displayName,
        number: held.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        ticket: matched?.ticket.ref ?? null,
        at: matched?.item.updatedAt ?? null,
        matchedRow: matched,
        held,
        owner: ownerByRepo.get(report.repoId) ?? null,
      })
    }
    for (const claim of report.claims) {
      if (claim.class !== 'stalled-confirmed') continue
      const matched = rowByKey.get(rowKey(report.repoId, claim.number)) ?? null
      items.push({
        kind: 'stalled',
        repoId: report.repoId,
        repo: matched?.item.repo ?? report.displayName,
        number: claim.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        ticket: matched?.ticket.ref ?? null,
        at: matched?.item.updatedAt ?? null,
        matchedRow: matched,
        claim,
      })
    }
  }

  for (const dispatch of snapshot.dispatch) {
    if (dispatch.budget === null) continue
    for (const note of dispatch.budget.notes) {
      if (!BUDGET_KINDS.has(note.kind)) continue
      const matched = rowByKey.get(rowKey(dispatch.repoId, note.number)) ?? null
      items.push({
        kind: 'budget',
        repoId: dispatch.repoId,
        repo: matched?.item.repo ?? null,
        number: note.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        ticket: matched?.ticket.ref ?? null,
        at: matched?.item.updatedAt ?? null,
        matchedRow: matched,
        note,
      })
    }
  }

  for (const report of snapshot.tick) {
    for (const repair of report.labelRepairs) {
      const matched = rowByKey.get(rowKey(report.repoId, repair.number)) ?? null
      items.push({
        kind: 'half-labelled',
        repoId: report.repoId,
        repo: matched?.item.repo ?? report.displayName,
        number: repair.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        ticket: matched?.ticket.ref ?? null,
        at: matched?.item.updatedAt ?? null,
        matchedRow: matched,
        repair,
      })
    }
  }

  return items.sort((a, b) => compareItems(a, b, displayNameOf))
}

export function needsYouCount(items: readonly NeedsYouItem[]): number {
  return items.length
}

export function repoNeedsYou(items: readonly NeedsYouItem[], repoId: RepoId): number {
  return items.filter((item) => item.repoId === repoId).length
}

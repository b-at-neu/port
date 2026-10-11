// Pure "needs you" derivation, built on `projectBoard`'s own rows so
// `actions`/`decisions` availability is reused, never re-derived.
import type { BudgetNote } from '../dispatch/types'
import type { HostedSessionSnapshot, SessionKey } from '../hosting/types'
import type { AskQuestion } from '../hosting/controls'
import type { StageDenial, InterruptedStage } from '../stage/types'
import type { RepoId } from '../repos'
import type { RepositoryState } from '../state/types'
import type { TickClaim, TickHeld } from '../tick/types'
import { projectBoard } from './project'
import type { BoardItemRow, BoardSnapshot } from './types'

/** The four label-keyed kinds, each carrying the row they came from. */
export type RowNeedsYouKind = 'plan-review' | 'ready-to-merge' | 'needs-human' | 'blocked'

export type NeedsYouKind = RowNeedsYouKind | 'budget' | 'held' | 'stalled' | 'stage-question' | 'stage-questions' | 'stage-blocked' | 'stage-denial' | 'stage-interrupted'

interface NeedsYouItemBase {
  readonly repoId: RepoId | null
  readonly repo: string | null
  readonly number: number | null
  readonly title: string | null
  readonly url: string | null
  /** `null` for every current kind — no kind left carries a real timestamp. */
  readonly at: string | null
  /** The board row at this (repoId, number), when one exists — lets `held`/`stalled` reuse its `decisions.unblock` too. */
  readonly matchedRow: BoardItemRow | null
}

/** One row per (repo, number, kind) — an item with two reasons appears twice, each with its own action. */
export type NeedsYouItem =
  | (NeedsYouItemBase & { readonly kind: 'plan-review'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'ready-to-merge'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'needs-human'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'blocked'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'budget'; readonly note: BudgetNote })
  | (NeedsYouItemBase & { readonly kind: 'held'; readonly held: TickHeld })
  | (NeedsYouItemBase & { readonly kind: 'stalled'; readonly claim: TickClaim })
  | (NeedsYouItemBase & { readonly kind: 'stage-question'; readonly sessionKey: SessionKey; readonly permissionId: string; readonly questions: readonly AskQuestion[] })
  | (NeedsYouItemBase & { readonly kind: 'stage-questions' | 'stage-blocked'; readonly sessionKey: SessionKey; readonly text: string | null })
  | (NeedsYouItemBase & { readonly kind: 'stage-denial'; readonly denial: StageDenial })
  | (NeedsYouItemBase & { readonly kind: 'stage-interrupted'; readonly interrupted: InterruptedStage })

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

function compareItems(a: NeedsYouItem, b: NeedsYouItem, displayNameOf: ReadonlyMap<RepoId, string>): number {
  const atA = a.at !== null ? Date.parse(a.at) : null
  const atB = b.at !== null ? Date.parse(b.at) : null
  if (atA !== null && atB !== null) return atB - atA
  if (atA !== null) return -1
  if (atB !== null) return 1

  const nameA = a.repoId !== null ? (displayNameOf.get(a.repoId) ?? '') : ''
  const nameB = b.repoId !== null ? (displayNameOf.get(b.repoId) ?? '') : ''
  if (nameA !== nameB) return nameA < nameB ? -1 : 1
  return (b.number ?? 0) - (a.number ?? 0)
}

const STAGE_HANDBACK_TEXT_CAP = 120

function stageHandbackText(result: HostedSessionSnapshot['lastResult']): string | null {
  if (result?.text === null || result?.text === undefined) return null
  return result.text.length > STAGE_HANDBACK_TEXT_CAP ? `${result.text.slice(0, STAGE_HANDBACK_TEXT_CAP)}…` : result.text
}

/** One entry per (repoId, number, kind), newest `at` first where known, then by repo then number descending. `sessions` is `session:list`'s own read — `[]` when the caller has none (the empty default keeps every pre-existing call site byte-identical). */
export function needsYouItems(snapshot: BoardSnapshot, now: Date, sessions: readonly HostedSessionSnapshot[] = []): readonly NeedsYouItem[] {
  const projection = projectBoard({ snapshot, groupBy: 'repo', now })
  const rows = projection.groups.flatMap((group) => group.rows)
  const rowByKey = new Map<string, BoardItemRow>(rows.map((row) => [rowKey(row.item.repoId, row.item.number), row]))
  const viewerByRepo = new Map<RepoId, string | null>(readyRepos(snapshot).map((repo) => [repo.repoId, repo.viewer]))
  const displayNameOf = new Map<RepoId, string>(readyRepos(snapshot).map((repo) => [repo.repoId, repo.displayName]))

  const items: NeedsYouItem[] = []

  // A live stage session with a pending AskUserQuestion never also produces a `stage-questions` item.
  const stageQuestionNumbers = new Set<string>()
  for (const session of sessions) {
    if (session.stage === null || session.repoId === null) continue
    const oldest = [...session.pendingPermissions].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
    if (oldest === undefined || oldest.interaction?.kind !== 'question') continue
    stageQuestionNumbers.add(`${session.repoId}:${String(session.stage.number)}`)
    const matched = rowByKey.get(rowKey(session.repoId, session.stage.number)) ?? null
    items.push({
      kind: 'stage-question',
      repoId: session.repoId,
      repo: matched?.item.repo ?? null,
      number: session.stage.number,
      title: matched?.item.title ?? null,
      url: matched?.item.url ?? null,
      at: oldest.requestedAt,
      matchedRow: matched,
      sessionKey: session.sessionKey,
      permissionId: oldest.permissionId,
      questions: oldest.interaction.questions,
    })
  }

  for (const session of sessions) {
    if (session.stage === null || session.repoId === null || session.phase === 'ended') continue
    const outcomeKind = session.lastResult?.text?.startsWith('BLOCKED:') === true ? 'stage-blocked' : session.lastResult?.text?.includes('QUESTIONS FOR HUMAN:') === true ? 'stage-questions' : null
    if (outcomeKind === null) continue
    if (stageQuestionNumbers.has(`${session.repoId}:${String(session.stage.number)}`)) continue
    const matched = rowByKey.get(rowKey(session.repoId, session.stage.number)) ?? null
    items.push({
      kind: outcomeKind,
      repoId: session.repoId,
      repo: matched?.item.repo ?? null,
      number: session.stage.number,
      title: matched?.item.title ?? null,
      url: matched?.item.url ?? null,
      at: session.lastResult?.at ?? null,
      matchedRow: matched,
      sessionKey: session.sessionKey,
      text: stageHandbackText(session.lastResult),
    })
  }

  for (const dispatch of snapshot.dispatch) {
    for (const denial of dispatch.denials) {
      const matched = rowByKey.get(rowKey(dispatch.repoId, denial.number)) ?? null
      items.push({ kind: 'stage-denial', repoId: dispatch.repoId, repo: matched?.item.repo ?? null, number: denial.number, title: matched?.item.title ?? null, url: matched?.item.url ?? null, at: denial.at, matchedRow: matched, denial })
    }
    for (const interrupted of dispatch.interrupted) {
      const matched = rowByKey.get(rowKey(dispatch.repoId, interrupted.number)) ?? null
      items.push({
        kind: 'stage-interrupted',
        repoId: dispatch.repoId,
        repo: matched?.item.repo ?? null,
        number: interrupted.number,
        title: matched?.item.title ?? null,
        url: matched?.item.url ?? null,
        at: interrupted.startedAt,
        matchedRow: matched,
        interrupted,
      })
    }
  }

  for (const row of rows) {
    const kind = needsYouReasonOf(row.stageLabel?.key)
    if (kind === undefined) continue
    const viewer = viewerByRepo.get(row.item.repoId) ?? null
    if (viewer !== null && !row.item.assignees.includes(viewer)) continue
    items.push({ kind, repoId: row.item.repoId, repo: row.item.repo, number: row.item.number, title: row.item.title, url: row.item.url, at: null, matchedRow: row, row })
  }

  for (const report of snapshot.tick) {
    for (const held of report.held) {
      if (!HELD_KINDS.has(held.reason)) continue
      const matched = rowByKey.get(rowKey(report.repoId, held.number)) ?? null
      items.push({ kind: 'held', repoId: report.repoId, repo: matched?.item.repo ?? report.displayName, number: held.number, title: matched?.item.title ?? null, url: matched?.item.url ?? null, at: null, matchedRow: matched, held })
    }
    for (const claim of report.claims) {
      if (claim.class !== 'stalled-confirmed') continue
      const matched = rowByKey.get(rowKey(report.repoId, claim.number)) ?? null
      items.push({ kind: 'stalled', repoId: report.repoId, repo: matched?.item.repo ?? report.displayName, number: claim.number, title: matched?.item.title ?? null, url: matched?.item.url ?? null, at: null, matchedRow: matched, claim })
    }
  }

  for (const dispatch of snapshot.dispatch) {
    if (dispatch.budget === null) continue
    for (const note of dispatch.budget.notes) {
      if (!BUDGET_KINDS.has(note.kind)) continue
      const matched = rowByKey.get(rowKey(dispatch.repoId, note.number)) ?? null
      items.push({ kind: 'budget', repoId: dispatch.repoId, repo: matched?.item.repo ?? null, number: note.number, title: matched?.item.title ?? null, url: matched?.item.url ?? null, at: null, matchedRow: matched, note })
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

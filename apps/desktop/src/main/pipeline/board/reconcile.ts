// No I/O, no `gh`, no `git`, no filesystem — main/pipeline/board/read.ts is the thin orchestrator that does the fetching this function composes.
import type { LabelRole } from '@/utils/labels/defaults'
import type { RepoSessionSlice } from '@/types/state'
import type {
  ItemsByNumberFetch,
  PipelineFetch,
} from '@/types/github'
import type { DenialsRead, UnresolvedReason, WorktreeEntry, WorktreesRead } from '@/types/local'
import type { RepositoryEntry } from '@/utils/repos'
import type {
  AttachedAgent,
  AttachedSession,
  FreshnessEntry,
  ItemStatus,
  LinkReason,
  OrphanItem,
  OrphanReason,
  ReconciledItem,
  RepositoryState,
  StageEntry,
  StatusEvidence,
  WaitingOn,
} from '@/types/state'
import type { LabelEventNode } from '@/types/github'
import { fullKeysOf, type PipelineView, type StoredItem } from '@/types/pipeline-state'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import { attachAgents, attachSessions, attachWorktrees, collectOrphanNumbers, indexWorkSessions, workSessionsFor } from '@/main/pipeline/board/attach'
import { closingReference, planPresentIn, sessionRequiredAt } from '@/main/pipeline/board/link'
import { stageOf } from '@/main/pipeline/board/stage'
import { CLAIM_SCAN_GRACE_MS } from '@/types/board'
import { codeReviewCount } from '@/utils/pipeline/gates'
import { parseFilesBlock } from '@/utils/pipeline/contention'

interface ReconcileRepositoryInput {
  readonly entry: Extract<RepositoryEntry, { status: 'ready' }>
  readonly pipelineFetch: PipelineFetch
  readonly itemsByNumberFetch: ItemsByNumberFetch | null
  readonly repoSessions: RepoSessionSlice
  readonly worktrees: WorktreesRead
  readonly denials: DenialsRead
  /** `undefined` or `labels` reads stage from GitHub's labels; `store` reads it from the stored items. */
  readonly view?: PipelineView
}

/** Every added key becomes a stage entry, oldest first — a marker is never a stage. */
function storedHistoryOf(stored: StoredItem): readonly StageEntry[] {
  const out: StageEntry[] = []
  for (const row of stored.history) {
    for (const key of row.add) {
      if (key !== 'marker' && key !== 'autoPlan') out.push({ key, actor: row.actor, at: row.at })
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

function itemStatesFreshness(fetch: ItemsByNumberFetch | null): FreshnessEntry {
  if (fetch === null) return { unavailable: 'no re-check needed' }
  return fetch.ok ? { at: fetch.fetchedAt } : { unavailable: fetch.message }
}

function worktreesFreshness(worktrees: WorktreesRead): FreshnessEntry {
  return worktrees.ok ? { at: worktrees.readAt } : { unavailable: worktrees.message }
}

function denialsFreshness(denials: DenialsRead): FreshnessEntry {
  return denials.ok ? { at: denials.readAt } : { unavailable: denials.message }
}

/**
 * First hit wins within the `in-flight` role: a session scan that could not run is `sessions-unavailable`, never `stalled`.
 * `no-claimant` is not reported until a scan has run at least `CLAIM_SCAN_GRACE_MS` after the in-flight label was added (`awaiting-scan`); a missing timestamp keeps `stalled`.
 */
function statusOf(
  role: LabelRole | null,
  sessionsAvailable: boolean,
  agents: readonly AttachedAgent[],
  sessions: readonly AttachedSession[],
  claimedAt: string | null,
  sessionsScannedAt: string | null,
): { readonly status: ItemStatus; readonly statusEvidence: StatusEvidence | null } {
  if (role === null) return { status: 'unstaged', statusEvidence: null }
  if (role === 'trigger') return { status: 'waiting', statusEvidence: null }
  if (role === 'gate') return { status: 'gated', statusEvidence: null }
  if (role === 'terminal') return { status: 'terminal', statusEvidence: null }
  if (!sessionsAvailable) return { status: 'in-flight', statusEvidence: 'sessions-unavailable' }
  if (agents.some((a) => a.activity !== 'dormant')) return { status: 'in-flight', statusEvidence: 'agent-active' }
  if (agents.length === 0 && sessions.some((s) => s.activity !== 'dormant')) return { status: 'in-flight', statusEvidence: 'session-active' }
  if (agents.length > 0 || sessions.length > 0) return { status: 'stalled', statusEvidence: 'all-dormant' }
  if (claimedAt !== null && sessionsScannedAt !== null && Date.parse(sessionsScannedAt) < Date.parse(claimedAt) + CLAIM_SCAN_GRACE_MS) {
    return { status: 'in-flight', statusEvidence: 'awaiting-scan' }
  }
  return { status: 'stalled', statusEvidence: 'no-claimant' }
}

/** Resolves raw label names to keys against this repository's vocabulary, oldest first — an unrecognised name is dropped, and so are `marker`/`autoPlan`. */
function stageHistoryOf(labelEvents: readonly LabelEventNode[], byName: ReadonlyMap<string, LabelVocabulary['labels'][number]['key']>): readonly StageEntry[] {
  const out: StageEntry[] = []
  for (const event of labelEvents) {
    const key = byName.get(event.label)
    if (key === undefined || key === 'marker' || key === 'autoPlan') continue
    out.push({ key, actor: event.actor, at: event.at })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/** Whichever source named the number first. A failed re-check yields `recheck-unavailable`, never collapsed into `number-not-found`. */
function resolveOrphan(number: number, fetch: ItemsByNumberFetch | null, worktreeEntries: readonly WorktreeEntry[]): OrphanItem {
  const from: OrphanItem['from'] = worktreeEntries.some((w) => w.correlation?.number === number) ? 'worktree' : 'agent'
  if (fetch === null || !fetch.ok) {
    return { number, kind: null, from, reason: 'recheck-unavailable' }
  }
  const resolved = fetch.resolved.find((r) => r.number === number)
  if (!resolved) return { number, kind: null, from, reason: 'number-not-found' }
  const reason: OrphanReason = resolved.mergedAt !== null ? 'item-merged' : resolved.state === 'CLOSED' ? 'item-closed' : 'item-open-unlabelled'
  return { number, kind: resolved.kind, from, reason }
}

export function reconcileRepository(input: ReconcileRepositoryInput): RepositoryState {
  const { entry, pipelineFetch, itemsByNumberFetch, repoSessions, worktrees, denials, view } = input
  const stored = new Map((view?.kind === 'store' ? view.items : []).map((item) => [`${item.kind}:${String(item.number)}`, item] as const))
  const repoId = entry.id
  const repo = entry.config.repo
  const displayName = entry.displayName

  if (!pipelineFetch.ok) {
    return {
      ok: false,
      repoId,
      repo,
      displayName,
      reason: 'github-unavailable',
      kind: pipelineFetch.kind,
      message: pipelineFetch.message,
      freshness: {
        github: { unavailable: pipelineFetch.message },
        itemStates: itemStatesFreshness(itemsByNumberFetch),
        sessions: repoSessions.freshness,
        worktrees: worktreesFreshness(worktrees),
        denials: denialsFreshness(denials),
      },
    }
  }

  const vocabulary = entry.config.vocabulary
  const labelsByName = new Map(vocabulary.labels.map((label) => [label.name, label.key]))
  const worktreeEntries = worktrees.ok ? worktrees.entries : []
  // Under a store view the store, not the cached sweep, decides which items exist.
  const fetchedItems = view?.kind === 'store' ? pipelineFetch.items.filter((item) => stored.has(`${item.kind}:${String(item.number)}`)) : pipelineFetch.items
  const orphanNumbers = collectOrphanNumbers(fetchedItems, worktreeEntries, repoSessions.agents)
  const workSessionIndex = indexWorkSessions(repoSessions.sessions, worktreeEntries)

  // The closing-keyword join, both directions: a pull request's body names the issue it closes, and the issue's `linked` is the first pull request naming it back.
  const prLinks = new Map<number, number>()
  for (const item of fetchedItems) {
    if (item.kind !== 'pull-request') continue
    const ref = closingReference(item.body)
    if (ref !== null) prLinks.set(item.number, ref)
  }
  const issueLinks = new Map<number, number>()
  for (const [prNumber, issueNumber] of prLinks) {
    if (!issueLinks.has(issueNumber)) issueLinks.set(issueNumber, prNumber)
  }

  const items: ReconciledItem[] = fetchedItems.map((item) => {
    const own: StoredItem | undefined = stored.get(`${item.kind}:${String(item.number)}`)
    const matchedKeys = own === undefined ? item.matchedKeys : fullKeysOf(own)
    const stageResult = stageOf(matchedKeys, vocabulary)
    const linked = item.kind === 'pull-request' ? (prLinks.get(item.number) ?? null) : (issueLinks.get(item.number) ?? null)
    // An issue carrying `prOpened` with no link in the open sweep means that pull request is no longer open, never "awaiting merge"; only a positively read MERGED closer makes it `counterpart-merged`.
    const linkReason: LinkReason | null =
      linked !== null
        ? null
        : item.kind === 'pull-request' || !matchedKeys.includes('prOpened')
          ? 'no-closing-keyword'
          : item.closingPullRequests?.some((pr) => pr.state === 'MERGED')
            ? 'counterpart-merged'
            : 'counterpart-not-open'

    const sessionRequired = sessionRequiredAt(item.body, item.kind)
    const attachTarget = { number: item.number, linked }
    const agents = attachAgents(attachTarget, repoSessions.agents)
    const sessions = attachSessions(attachTarget, repoSessions.sessions)
    const worktreeAttachments = attachWorktrees(attachTarget, worktreeEntries)
    const workSessions = workSessionsFor(workSessionIndex, item)

    const stageHistory = own === undefined ? stageHistoryOf(item.labelEvents, labelsByName) : storedHistoryOf(own)
    const inFlightKey = stageResult.stages.find((s) => s.role === 'in-flight')?.key
    const claimedAt = stageHistory.findLast((entry) => entry.key === inFlightKey)?.at ?? null
    const sessionsScannedAt = 'at' in repoSessions.freshness ? repoSessions.freshness.at : null

    const { status, statusEvidence } = statusOf(stageResult.stage, repoSessions.available, agents, sessions, claimedAt, sessionsScannedAt)
    const waitingOn: WaitingOn | null =
      status !== 'waiting' ? null : item.assignees.length === 0 ? 'nobody' : sessionRequired ? 'operator-session' : 'cockpit'

    const sources: Array<ReconciledItem['sources'][number]> = ['github']
    if (agents.length > 0 || sessions.length > 0) sources.push('sessions')
    if (worktreeAttachments.length > 0) sources.push('worktrees')

    // Parsed for issues only — a pull request's `## Changes` block is prose, not a fence.
    const claimedFiles = item.kind === 'issue' ? parseFilesBlock(item.body) : null

    // Precomputed so the renderer never re-derives it from raw review bodies; `null` for an issue. The stored count is a high-water mark, so it fails toward the cap.
    const reviewCycleCount = item.kind === 'pull-request' ? Math.max(own?.reviewCycles ?? 0, codeReviewCount(item.reviews ?? undefined)) : null

    // `null` for a pull request — a `## Changes` block is prose, never this heading.
    const planPresent = item.kind === 'issue' ? planPresentIn(item.body) : null

    return {
      repoId,
      repo: item.repo,
      kind: item.kind,
      number: item.number,
      title: item.title,
      url: item.url,
      assignees: item.assignees,
      stage: stageResult.stage,
      stages: stageResult.stages,
      stageAmbiguous: stageResult.stageAmbiguous,
      marked: stageResult.marked,
      autoPlan: stageResult.autoPlan,
      status,
      statusEvidence,
      waitingOn,
      sessionRequired,
      linked,
      linkReason,
      agents,
      sessions,
      worktrees: worktreeAttachments,
      workSessions,
      state: item.state,
      mergedAt: item.mergedAt,
      updatedAt: item.updatedAt,
      stageHistory,
      matchedKeys,
      sources,
      claimedFiles,
      headRefOid: item.headRefOid,
      mergeable: item.mergeable,
      reviews: item.reviews,
      comments: item.comments,
      reviewCycleCount,
      checkRollup: item.checkRollup,
      planPresent,
      blockers: item.blockers,
      blockerComments: item.blockerComments,
      closingPullRequests: item.closingPullRequests,
      ...(own === undefined ? {} : { mirrorFailure: own.mirrorFailure }),
    }
  })

  const orphans: OrphanItem[] = orphanNumbers.map((number) => resolveOrphan(number, itemsByNumberFetch, worktreeEntries))
  const uncorrelatedWorktrees = worktreeEntries
    .filter((w): w is WorktreeEntry & { unresolved: UnresolvedReason } => w.unresolved !== null)
    .map((w) => ({ path: w.path, reason: w.unresolved }))

  // `null`, never 0, when the read itself failed; otherwise registered is every entry, attached is what actually reached an item.
  const worktreeTotals = worktrees.ok
    ? { registered: worktreeEntries.length, attached: items.reduce((sum, item) => sum + item.worktrees.length, 0), uncorrelated: uncorrelatedWorktrees.length }
    : null

  return {
    ok: true,
    repoId,
    repo,
    displayName,
    items,
    orphans,
    uncorrelatedWorktrees,
    denials,
    diagnostics: entry.diagnostics,
    vocabulary: pipelineFetch.vocabulary,
    unavailable: pipelineFetch.unavailable,
    truncated: pipelineFetch.truncated,
    rateLimit: pipelineFetch.rateLimit,
    freshness: {
      github: { at: pipelineFetch.fetchedAt },
      itemStates: itemStatesFreshness(itemsByNumberFetch),
      sessions: repoSessions.freshness,
      worktrees: worktreesFreshness(worktrees),
      denials: denialsFreshness(denials),
    },
    worktreeTotals,
    viewer: pipelineFetch.viewer,
    integrationChecks: pipelineFetch.integrationChecks,
    approvalGate: entry.config.modules.approvalGate,
    disabled: pipelineFetch.disabled,
    concurrency: entry.config.concurrency,
    reviewCycleCap: entry.config.reviewCycleCap,
  }
}

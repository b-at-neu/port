// No I/O, no `gh`, no `git`, no filesystem — main/state/read.ts is the thin orchestrator that does the fetching this function composes.
import type { LabelRole } from '../../shared/labels/defaults'
import type {
  ItemsByNumberFetch,
  PipelineFetch,
} from '../../shared/github/types'
import type { AgentRecord, SessionRecord } from '../../shared/sessions/types'
import type { DenialsRead, UnresolvedReason, WorktreeEntry, WorktreesRead } from '../../shared/local/types'
import type { RepositoryEntry } from '../../shared/repos'
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
  StatusEvidence,
  WaitingOn,
} from '../../shared/state/types'
import { attachAgents, attachSessions, attachWorktrees, collectOrphanNumbers } from './attach'
import { closingReference, sessionRequiredAt } from './link'
import { stageOf } from './stage'
import { codeReviewCount } from '../../../../../scripts/port-tick/gates'
import { parseFilesBlock } from '../../../../../scripts/port-tick/contention'

/** The repository-scoped slice of the whole-machine `SessionScan`, never a second scan. `available` is `false` only when the scan itself failed. */
export interface RepoSessionSlice {
  readonly agents: readonly AgentRecord[]
  readonly sessions: readonly SessionRecord[]
  readonly available: boolean
  readonly freshness: FreshnessEntry
}

export interface ReconcileRepositoryInput {
  readonly entry: Extract<RepositoryEntry, { status: 'ready' }>
  readonly pipelineFetch: PipelineFetch
  readonly itemsByNumberFetch: ItemsByNumberFetch | null
  readonly repoSessions: RepoSessionSlice
  readonly worktrees: WorktreesRead
  readonly denials: DenialsRead
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

/** First hit wins within the `in-flight` role: a session scan that could not run is `sessions-unavailable`, never `stalled`. */
function statusOf(
  role: LabelRole | null,
  sessionsAvailable: boolean,
  agents: readonly AttachedAgent[],
  sessions: readonly AttachedSession[],
): { readonly status: ItemStatus; readonly statusEvidence: StatusEvidence | null } {
  if (role === null) return { status: 'unstaged', statusEvidence: null }
  if (role === 'trigger') return { status: 'waiting', statusEvidence: null }
  if (role === 'gate') return { status: 'gated', statusEvidence: null }
  if (role === 'terminal') return { status: 'terminal', statusEvidence: null }
  if (!sessionsAvailable) return { status: 'in-flight', statusEvidence: 'sessions-unavailable' }
  if (agents.some((a) => a.activity !== 'dormant')) return { status: 'in-flight', statusEvidence: 'agent-active' }
  if (agents.length === 0 && sessions.some((s) => s.activity !== 'dormant')) return { status: 'in-flight', statusEvidence: 'session-active' }
  if (agents.length > 0 || sessions.length > 0) return { status: 'stalled', statusEvidence: 'all-dormant' }
  return { status: 'stalled', statusEvidence: 'no-claimant' }
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
  const { entry, pipelineFetch, itemsByNumberFetch, repoSessions, worktrees, denials } = input
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
  const worktreeEntries = worktrees.ok ? worktrees.entries : []
  const orphanNumbers = collectOrphanNumbers(pipelineFetch.items, worktreeEntries, repoSessions.agents)

  // The closing-keyword join, both directions: a pull request's body names the issue it closes, and the issue's `linked` is the first pull request naming it back.
  const prLinks = new Map<number, number>()
  for (const item of pipelineFetch.items) {
    if (item.kind !== 'pull-request') continue
    const ref = closingReference(item.body)
    if (ref !== null) prLinks.set(item.number, ref)
  }
  const issueLinks = new Map<number, number>()
  for (const [prNumber, issueNumber] of prLinks) {
    if (!issueLinks.has(issueNumber)) issueLinks.set(issueNumber, prNumber)
  }

  const items: ReconciledItem[] = pipelineFetch.items.map((item) => {
    const stageResult = stageOf(item.matchedKeys, vocabulary)
    const linked = item.kind === 'pull-request' ? (prLinks.get(item.number) ?? null) : (issueLinks.get(item.number) ?? null)
    // An issue carrying `prOpened` with no link in the open sweep means that pull request is no longer open, never "awaiting merge".
    const linkReason: LinkReason | null =
      linked !== null ? null : item.kind === 'pull-request' || !item.matchedKeys.includes('prOpened') ? 'no-closing-keyword' : 'counterpart-not-open'

    const sessionRequired = sessionRequiredAt(item.body, item.kind)
    const attachTarget = { number: item.number, linked }
    const agents = attachAgents(attachTarget, repoSessions.agents)
    const sessions = attachSessions(attachTarget, repoSessions.sessions)
    const worktreeAttachments = attachWorktrees(attachTarget, worktreeEntries)

    const { status, statusEvidence } = statusOf(stageResult.stage, repoSessions.available, agents, sessions)
    const waitingOn: WaitingOn | null =
      status !== 'waiting' ? null : item.assignees.length === 0 ? 'nobody' : sessionRequired ? 'operator-session' : 'cockpit'

    const sources: Array<ReconciledItem['sources'][number]> = ['github']
    if (agents.length > 0 || sessions.length > 0) sources.push('sessions')
    if (worktreeAttachments.length > 0) sources.push('worktrees')

    // Parsed for issues only — a pull request's `## Changes` block is prose, not a fence.
    const claimedFiles = item.kind === 'issue' ? parseFilesBlock(item.body) : null

    // Precomputed so the renderer never re-derives it from raw review bodies; `null` for an issue.
    const reviewCycleCount = item.kind === 'pull-request' ? codeReviewCount(item.reviews ?? undefined) : null

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
      state: item.state,
      mergedAt: item.mergedAt,
      matchedKeys: item.matchedKeys,
      sources,
      claimedFiles,
      headRefOid: item.headRefOid,
      mergeable: item.mergeable,
      reviews: item.reviews,
      comments: item.comments,
      reviewCycleCount,
      checkRollup: item.checkRollup,
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
    approvalGate: entry.config.modules.approvalGate,
    disabled: pipelineFetch.disabled,
    concurrency: entry.config.concurrency,
    reviewCycleCap: entry.config.reviewCycleCap,
  }
}

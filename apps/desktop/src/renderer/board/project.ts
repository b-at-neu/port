// The pure board projection — everything the screen decides lives here, testable under `environment: 'node'` with no jsdom dependency.
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { isLiveStageSession } from '@/utils/stage/live'
import { inspectDenials } from '@/renderer/local/inspect'
import { actionsFor } from '@/utils/actions/plan'
import { decisionsFor } from '@/utils/actions/decide'
import type { RepoId } from '@/utils/repos'
import { ticketIndex } from '@/utils/tickets/ticket'
import type { ReconciledItem, RepositoryFreshness, RepositoryState, StageLabel } from '@/types/state'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '@/types/board'
import type { BoardGroup, BoardItemRow, BoardProjection, BoardRepositorySummary, BoardSnapshot, DisplayStatus, GroupBy, LiveStage, RepositoryHealth, SourceHealth, SourceKind } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { blockedOnOf } from '@/renderer/board/blocked-on'

/** The eventual-consistency suppression; `item.status` is never rewritten. Fails toward under-reporting — renders `in-flight` rather than a possibly-phantom `stalled`. */
export function displayStatus(item: { readonly status: string }, repoHealth: RepositoryHealth | undefined, freshness: RepositoryFreshness, now: Date): DisplayStatus {
  if (item.status !== 'stalled') {
    return { status: item.status as DisplayStatus['status'], staleGithub: false, githubAgeMs: null }
  }

  const githubEntry = freshness.github
  if (!('at' in githubEntry)) {
    return { status: 'in-flight', staleGithub: true, githubAgeMs: null }
  }

  const readAt = Date.parse(githubEntry.at)
  const githubAgeMs = Number.isNaN(readAt) ? null : now.getTime() - readAt
  const githubHealthy = repoHealth === undefined || repoHealth.github.consecutiveFailures === 0
  const githubIntervalMs = repoHealth?.github.intervalMs ?? SOURCE_BASE_INTERVAL_MS.github
  const withinGrace = githubAgeMs !== null && githubAgeMs <= githubIntervalMs + STALE_GRACE_MS

  if (githubHealthy && withinGrace) {
    return { status: 'stalled', staleGithub: false, githubAgeMs }
  }
  return { status: 'in-flight', staleGithub: true, githubAgeMs }
}

/** The first entry of `item.stages` whose `role === item.stage`, `null` when `stage` is `null`. */
export function stageLabelOf(item: { readonly stage: string | null; readonly stages: readonly StageLabel[] }): StageLabel | null {
  if (item.stage === null) return null
  return item.stages.find((label) => label.role === item.stage) ?? null
}

/** `a` is strictly worse than `b`: more consecutive failures first, then the older or never-succeeded last read. */
function isWorseHealth(a: SourceHealth, b: SourceHealth): boolean {
  if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures > b.consecutiveFailures
  const aAt = a.lastSuccessAt === null ? -Infinity : Date.parse(a.lastSuccessAt)
  const bAt = b.lastSuccessAt === null ? -Infinity : Date.parse(b.lastSuccessAt)
  return aAt < bAt
}

/** The worst `kind` health across every repository, `null` when there are none. */
export function worstHealth(healths: readonly RepositoryHealth[], kind: SourceKind): SourceHealth | null {
  let worst: SourceHealth | null = null
  for (const h of healths) {
    const candidate = h[kind]
    if (worst === null || isWorseHealth(candidate, worst)) worst = candidate
  }
  return worst
}

function repoDisplayName(repo: Extract<RepositoryState, { readonly ok: true }>): string {
  return repo.displayName
}

/** Never a line total — the count belongs to one actor's one qualifying window on one shape. */
function denialBurstCopyOf(repo: Extract<RepositoryState, { readonly ok: true }>, sessions: BoardSnapshot['state']['sessions']): string | null {
  const inspection = inspectDenials({ read: repo.denials, sessions })
  if (!inspection.ok || !inspection.present) return null
  const burst = inspection.byShape.find((shape) => shape.burst !== null)?.burst ?? null
  if (burst === null) return null
  const minutes = Math.max(1, Math.round((Date.parse(burst.endedAt) - Date.parse(burst.startedAt)) / 60_000))
  return `${String(burst.count)} denials on one command in ${String(minutes)}m`
}

function compareRows(a: BoardItemRow, b: BoardItemRow, displayNameOf: ReadonlyMap<RepoId, string>): number {
  const nameA = displayNameOf.get(a.item.repoId) ?? ''
  const nameB = displayNameOf.get(b.item.repoId) ?? ''
  if (nameA !== nameB) return nameA < nameB ? -1 : 1
  return a.ticket.ref.number - b.ticket.ref.number
}

interface ProjectBoardParams {
  readonly snapshot: BoardSnapshot
  readonly groupBy: GroupBy
  readonly now: Date
  readonly sessions?: readonly HostedSessionSnapshot[]
}

function liveStageKey(repoId: RepoId, kind: string, number: number): string {
  return `${repoId}:${kind}:${String(number)}`
}

interface LiveStageEntry extends LiveStage {
  readonly startedAt: string
  readonly working: boolean
}

/** The newest live stage session per (repo, kind, number). */
function liveStagesOf(sessions: readonly HostedSessionSnapshot[]): ReadonlyMap<string, LiveStageEntry> {
  const live = new Map<string, LiveStageEntry>()
  for (const s of sessions) {
    if (s.stage === null || s.repoId === null || !isLiveStageSession(s)) continue
    const key = liveStageKey(s.repoId, s.stage.kind, s.stage.number)
    const current = live.get(key)
    if (current === undefined || Date.parse(s.startedAt) > Date.parse(current.startedAt)) {
      live.set(key, { agent: s.stage.agent, trigger: s.stage.trigger, sessionKey: s.sessionKey, startedAt: s.startedAt, working: s.phase === 'starting' || s.phase === 'streaming' })
    }
  }
  return live
}

function newestLive(candidates: readonly (LiveStageEntry | undefined)[]): LiveStageEntry | undefined {
  let newest: LiveStageEntry | undefined
  for (const candidate of candidates) {
    if (candidate !== undefined && (newest === undefined || Date.parse(candidate.startedAt) > Date.parse(newest.startedAt))) newest = candidate
  }
  return newest
}

/** Everything the board renders, computed once. Pure over an already-built
 *  `BoardSnapshot` — no IPC, no timer, no DOM. */
export function projectBoard(params: ProjectBoardParams): BoardProjection {
  const { snapshot, groupBy, now, sessions = [] } = params
  const liveStages = liveStagesOf(sessions)
  const healthByRepo = new Map<RepoId, RepositoryHealth>(snapshot.health.map((h) => [h.repoId, h]))
  const notReady = snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: false }> => !r.ok)
  const readyRepos = snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)
  const displayNameOf = new Map<RepoId, string>(readyRepos.map((r) => [r.repoId, repoDisplayName(r)]))

  // A row whose (repoId, number) is interrupted overrides to `interrupted`, whatever `item.status` says.
  const interruptedKeys = new Set(snapshot.dispatch.flatMap((d) => d.interrupted.map((i) => `${d.repoId}:${String(i.number)}`)))
  const autoApprovingKeys = new Set(snapshot.autoPlan.flatMap((status) => status.approving.map((number) => `${status.repoId}:${String(number)}`)))

  const rows: BoardItemRow[] = []
  for (const repo of readyRepos) {
    const health = healthByRepo.get(repo.repoId)
    for (const ticket of ticketIndex(repo.items).tickets) {
      const item = ticket.primary
      const members = [ticket.issue, ticket.pullRequest].filter((member): member is ReconciledItem => member !== null)
      const actions = actionsFor({ item, viewer: repo.viewer, approvalGate: repo.approvalGate })
      const found = newestLive(members.map((member) => liveStages.get(liveStageKey(repo.repoId, member.kind, member.number))))
      const liveStage: LiveStage | null = found === undefined ? null : { agent: found.agent, trigger: found.trigger, sessionKey: found.sessionKey }
      const decisions = decisionsFor({ item, viewer: repo.viewer, reviewCycleCap: repo.reviewCycleCap, liveStage: liveStage !== null })
      let ds: DisplayStatus
      if (members.some((member) => interruptedKeys.has(`${repo.repoId}:${String(member.number)}`))) ds = { status: 'interrupted', staleGithub: false, githubAgeMs: null }
      else if (found?.working === true && item.status === 'waiting') ds = { status: 'in-flight', staleGithub: false, githubAgeMs: null }
      else ds = displayStatus(item, health, repo.freshness, now)
      const stageLabel = stageLabelOf(item)
      const autoApproving = autoApprovingKeys.has(`${repo.repoId}:${String(item.number)}`)
      const blockedOn = blockedOnOf({ ticket, stageKey: stageLabel?.key, sessions, repoId: repo.repoId })
      rows.push({ item, ticket, displayStatus: ds, liveStage, stageLabel, actions, decisions, viewer: repo.viewer, autoApproving, blockedOn })
    }
  }
  rows.sort((a, b) => compareRows(a, b, displayNameOf))
  const ungated = rows.filter((row) => row.actions.gate.available)

  const groups: BoardGroup[] =
    groupBy === 'repo'
      ? readyRepos
          .map((repo): BoardGroup => ({ key: repo.repoId, name: repo.displayName, rows: rows.filter((row) => row.item.repoId === repo.repoId) }))
          .filter((group) => group.rows.length > 0)
      : LABEL_DEFAULTS.filter((def) => def.role !== 'marker')
          .map((def): BoardGroup => ({ key: def.key, name: def.name, rows: rows.filter((row) => row.stageLabel?.key === def.key) }))
          .filter((group) => group.rows.length > 0)

  const repositorySummaries: BoardRepositorySummary[] = readyRepos.map((repo) => {
    const repoRows = rows.filter((row) => row.item.repoId === repo.repoId)
    return {
      repoId: repo.repoId,
      displayName: repo.displayName,
      waiting: repoRows.filter((row) => row.displayStatus.status === 'waiting').length,
      inFlight: repoRows.filter((row) => row.displayStatus.status === 'in-flight').length,
      stalled: repoRows.filter((row) => row.displayStatus.status === 'stalled').length,
      worktreeTotal: repo.worktreeTotals?.registered ?? null,
      denialBurst: denialBurstCopyOf(repo, snapshot.state.sessions),
    }
  })

  const base = { groupBy, groups, rows, notReady, repositorySummaries, totalItems: rows.length, ungated }
  return { ...base, emittedAt: snapshot.emittedAt, signature: JSON.stringify(base) }
}

/** A compact string over every rendered field, deliberately excluding `emittedAt`, exported so a caller holding two projections can compare them directly. */
export function boardSignature(projection: BoardProjection): string {
  return JSON.stringify({
    groupBy: projection.groupBy,
    groups: projection.groups,
    notReady: projection.notReady,
    repositorySummaries: projection.repositorySummaries,
    totalItems: projection.totalItems,
    ungated: projection.ungated,
  })
}

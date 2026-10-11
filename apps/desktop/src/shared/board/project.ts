// The pure board projection — everything the screen decides lives here, testable under `environment: 'node'` with no jsdom dependency.
import { LABEL_DEFAULTS } from '../labels/defaults'
import { inspectDenials } from '../local/inspect'
import { actionsFor } from '../actions/plan'
import { decisionsFor } from '../actions/decide'
import type { RepoId } from '../repos'
import type { RepositoryFreshness, RepositoryState, StageLabel } from '../state/types'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from './types'
import type { BoardGroup, BoardItemRow, BoardProjection, BoardRepositorySummary, BoardSnapshot, DisplayStatus, GroupBy, RepositoryHealth, SourceHealth, SourceKind } from './types'

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
  const withinGrace = githubAgeMs !== null && githubAgeMs <= SOURCE_BASE_INTERVAL_MS.github + STALE_GRACE_MS

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
  return a.item.number - b.item.number
}

export interface ProjectBoardParams {
  readonly snapshot: BoardSnapshot
  readonly groupBy: GroupBy
  readonly now: Date
}

/** Everything the board renders, computed once. Pure over an already-built
 *  `BoardSnapshot` — no IPC, no timer, no DOM. */
export function projectBoard(params: ProjectBoardParams): BoardProjection {
  const { snapshot, groupBy, now } = params
  const healthByRepo = new Map<RepoId, RepositoryHealth>(snapshot.health.map((h) => [h.repoId, h]))
  const notReady = snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: false }> => !r.ok)
  const readyRepos = snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)
  const displayNameOf = new Map<RepoId, string>(readyRepos.map((r) => [r.repoId, repoDisplayName(r)]))

  // A row whose (repoId, number) is interrupted overrides to `interrupted`, whatever `item.status` says.
  const interruptedKeys = new Set(snapshot.dispatch.flatMap((d) => d.interrupted.map((i) => `${d.repoId}:${String(i.number)}`)))

  const rows: BoardItemRow[] = []
  for (const repo of readyRepos) {
    const health = healthByRepo.get(repo.repoId)
    for (const item of repo.items) {
      const actions = actionsFor({ item, viewer: repo.viewer, approvalGate: repo.approvalGate })
      const decisions = decisionsFor({ item, viewer: repo.viewer, reviewCycleCap: repo.reviewCycleCap })
      const ds: DisplayStatus = interruptedKeys.has(`${repo.repoId}:${String(item.number)}`)
        ? { status: 'interrupted', staleGithub: false, githubAgeMs: null }
        : displayStatus(item, health, repo.freshness, now)
      rows.push({ item, displayStatus: ds, stageLabel: stageLabelOf(item), actions, decisions })
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

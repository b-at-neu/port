// The `failing` and `registry-error` scenarios: typed `ok: false` reads that pass through the real derivation, never a throw.
import { DEFAULT_POLL_POLICY, SOURCE_BASE_INTERVAL_MS } from '@/types/board'
import type { BoardSnapshot, RepositoryHealth } from '@/types/board'
import type { BacklogResponse } from '@/types/backlog'
import type { ReposListResponse } from '@/types/ipc'
import type { SessionScan } from '@/types/sessions'
import type { PipelineFetch } from '@/types/github'
import type { RepoId } from '@/utils/repos'
import { reconcileRepository } from '@/main/state/reconcile'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { gadgetsRepositoryState, notReadyRepositoryState, repositoryHealth, widgetsEntry } from './board'
import { fixtureEmptySessionScan } from './unregistered'
import { GADGETS_ID, WIDGETS_ID } from './repos'

const MINUTE = 60_000
const NETWORK_MESSAGE = 'getaddrinfo ENOTFOUND api.github.com'

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * MINUTE).toISOString()
}

export const FIXTURE_REGISTRY_ERROR: ReposListResponse = { ok: false, kind: 'registry-malformed', message: 'Unexpected token } in JSON at position 212' }

export function fixtureFailingBacklog(now: Date, repoId: RepoId): BacklogResponse {
  const fetchedAt = now.toISOString()
  if (repoId === WIDGETS_ID) return { ok: false, kind: 'rate-limited', message: 'API rate limit exceeded for user ID 1', fetchedAt }
  return { ok: false, kind: 'network', message: NETWORK_MESSAGE, fetchedAt }
}

export function fixtureFailingSessionScan(now: Date): Extract<SessionScan, { readonly ok: false }> {
  return { ok: false, kind: 'projects-unreadable', message: "EACCES: permission denied, scandir '/home/you/.claude/projects'", scannedAt: now.toISOString() }
}

function widgetsGithubUnavailable(now: Date) {
  const entry = widgetsEntry()
  const pipelineFetch: PipelineFetch = { ok: false, kind: 'network', message: NETWORK_MESSAGE, fetchedAt: now.toISOString() }
  return reconcileRepository({
    entry,
    pipelineFetch,
    itemsByNumberFetch: null,
    repoSessions: { agents: [], sessions: [], available: true, freshness: { at: now.toISOString() } },
    worktrees: { ok: true, mainPath: '/home/you/src/widgets', entries: [], subjectsAvailable: true, readAt: now.toISOString() },
    denials: { ok: true, present: false, path: '/home/you/src/widgets/.agents/denials.log', readAt: now.toISOString() },
  })
}

function widgetsFailingHealth(now: Date): RepositoryHealth {
  const healthy = repositoryHealth(WIDGETS_ID, now)
  const github = { ...healthy.github, lastSuccessAt: minutesAgo(now, 25), consecutiveFailures: 3, lastError: NETWORK_MESSAGE, intervalMs: SOURCE_BASE_INTERVAL_MS.github * 4 }
  return { ...healthy, github }
}

export function fixtureFailingBoard(now: Date): BoardSnapshot {
  const widgets = widgetsGithubUnavailable(now)
  const notReady = notReadyRepositoryState()
  const gadgets = gadgetsRepositoryState(now)
  const widgetsConfig = widgetsEntry().config

  const nextDecisionAt = new Date(now.getTime() + SOURCE_BASE_INTERVAL_MS.github)
  const tickParams = {
    ledger: createDispatchLedger(),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt,
    now: () => now,
    reviewCycleCap: widgetsConfig.reviewCycleCap,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: widgetsConfig.checkDispositions,
    holdSessionRequired: true,
  }
  const tick = [widgets, notReady, gadgets].map((repository) => planTick({ repository, ...tickParams }))

  return {
    state: { repositories: [widgets, notReady, gadgets], sessions: fixtureEmptySessionScan(now), readAt: now.toISOString() },
    health: [widgetsFailingHealth(now), repositoryHealth(GADGETS_ID, now)],
    policy: DEFAULT_POLL_POLICY,
    tick,
    runStates: { store: { kind: 'unreadable', message: 'Unexpected end of JSON input', path: '/home/you/.config/port/dispatch.json' }, repositories: [] },
    nextWakeupAt: nextDecisionAt.toISOString(),
    emittedAt: now.toISOString(),
    dispatch: [],
    autoPlan: [],
  }
}

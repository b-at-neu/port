// The only clock in the main process (#80 Decision 2) — one timer,
// rescheduled to the earliest `nextDueAt` across every (repository, source),
// never a fixed tick that wakes to do nothing and never one timer per
// source. `schedule.ts` decides *when*; this file is the only place under
// `src/main/` allowed to name `setTimeout`.
import type { GhRunner } from '../github'
import type { WorktreesGitRunner as GitRunner } from '../local'
import { readSessionState } from '../sessions'
import type { RepoId } from '../../shared/repos'
import type { RepositoryEntry } from '../../shared/repos'
import { DEFAULT_POLL_POLICY, SOURCE_KINDS, initialHealth } from '../../shared/board/types'
import type { BoardSnapshot, RepositoryHealth, SourceHealth, SourceKind } from '../../shared/board/types'
import { isReady, projectFromCache } from './read'
import { afterFailure, afterSuccess, deferredUntil, nextDueAt } from './schedule'
import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from './sources'
import type { RefreshOutcome, SourceCache } from './sources'

export interface RefreshRequest {
  readonly repoId?: RepoId
  readonly source?: SourceKind
}

export interface TimerHandle {
  readonly clear: () => void
}

export type TimerFactory = (callback: () => void, ms: number) => TimerHandle

const defaultSetTimer: TimerFactory = (callback, ms) => {
  const handle = setTimeout(callback, ms)
  return { clear: () => clearTimeout(handle) }
}

export interface CreatePipelineWatcherParams {
  /** A static list, or a provider re-invoked on the GitHub cadence — so a
   *  repository added or removed on the Repositories view appears on the
   *  board without a restart. */
  readonly repositories: readonly RepositoryEntry[] | (() => Promise<readonly RepositoryEntry[]>)
  readonly onSnapshot: (snapshot: BoardSnapshot) => void
  readonly gh?: GhRunner
  readonly git?: GitRunner
  readonly sessionReader?: Parameters<typeof readSessionState>[0]['reader']
  readonly claudeHome?: string
  readonly now?: () => Date
  readonly setTimer?: TimerFactory
}

export interface PipelineWatcher {
  readonly refresh: (request?: RefreshRequest) => Promise<BoardSnapshot>
  readonly snapshot: () => BoardSnapshot
  readonly stop: () => void
}

function repoRefOf(entry: Extract<RepositoryEntry, { status: 'ready' }>): { readonly owner: string; readonly name: string } {
  const [owner, name] = entry.config.repo.split('/')
  return { owner: owner ?? '', name: name ?? '' }
}

function isForced(request: RefreshRequest | undefined, kind: SourceKind, repoId?: RepoId): boolean {
  if (request === undefined) return false
  if (request.source !== undefined && request.source !== kind) return false
  if (request.repoId !== undefined && repoId !== undefined && request.repoId !== repoId) return false
  return true
}

export function createPipelineWatcher(params: CreatePipelineWatcherParams): PipelineWatcher {
  const now = params.now ?? (() => new Date())
  const setTimer = params.setTimer ?? defaultSetTimer
  const cache: SourceCache = createSourceCache()
  const health = new Map<RepoId, RepositoryHealth>()
  let sessionsHealth: SourceHealth = initialHealth('sessions')
  const inFlight = new Set<string>()
  let repositories: readonly RepositoryEntry[] = Array.isArray(params.repositories) ? params.repositories : []
  let hasListedRepositories = Array.isArray(params.repositories)
  let stopped = false
  let timer: TimerHandle | null = null
  let latest: BoardSnapshot = {
    state: {
      repositories: [],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: now().toISOString() },
      readAt: now().toISOString(),
    },
    health: [],
    policy: DEFAULT_POLL_POLICY,
    emittedAt: now().toISOString(),
  }

  function ensureHealth(repoId: RepoId): RepositoryHealth {
    const existing = health.get(repoId)
    if (existing) return existing
    const created: RepositoryHealth = { repoId, github: initialHealth('github'), sessions: sessionsHealth, worktrees: initialHealth('worktrees'), denials: initialHealth('denials') }
    health.set(repoId, created)
    return created
  }

  function buildSnapshot(): BoardSnapshot {
    const readyEntries = repositories.filter(isReady)
    const state = projectFromCache(cache, repositories, now)
    const healthList = readyEntries.map((entry) => {
      const h = ensureHealth(entry.id)
      return { ...h, sessions: sessionsHealth }
    })
    latest = { state, health: healthList, policy: DEFAULT_POLL_POLICY, emittedAt: now().toISOString() }
    return latest
  }

  async function runRepoSource(entry: Extract<RepositoryEntry, { status: 'ready' }>, kind: 'github' | 'worktrees' | 'denials'): Promise<void> {
    const key = `${entry.id}:${kind}`
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
      let outcome: RefreshOutcome
      if (kind === 'worktrees') {
        outcome = await refreshWorktrees(cache, { repoId: entry.id, repoRoot: entry.path, git: params.git, now })
      } else if (kind === 'denials') {
        outcome = await refreshDenials(cache, { repoId: entry.id, repoRoot: entry.path, git: params.git, now })
      } else {
        const worktrees = cache.worktrees.get(entry.id)
        const worktreeEntries = worktrees?.ok ? worktrees.entries : []
        const sessions = cache.sessions
        const agents = sessions?.ok ? sessions.agents.filter((a) => a.repoId === entry.id) : []
        outcome = await refreshGithub(cache, { repoId: entry.id, repo: repoRefOf(entry), vocabulary: entry.config.vocabulary, worktreeEntries, agents, gh: params.gh, now })
      }
      const current = ensureHealth(entry.id)
      const previous = current[kind]
      let updated: SourceHealth
      if (outcome.ok) {
        updated = afterSuccess(previous, kind, now())
        // A known reset instant always beats a doubled guess, even on a
        // success whose own window reports low headroom (Decision 4).
        if (kind === 'github') {
          const defer = deferredUntil(outcome.rateLimit ?? null, null)
          if (defer !== null) updated = { ...updated, deferredUntil: defer }
        }
      } else {
        updated = afterFailure(previous, kind, now(), outcome.error ?? 'unknown error', kind === 'github' ? deferredUntil(outcome.rateLimit ?? null, outcome.failureKind ?? null) : null)
      }
      health.set(entry.id, { ...current, [kind]: updated })
    } finally {
      inFlight.delete(key)
    }
  }

  async function runSessions(readyEntries: readonly Extract<RepositoryEntry, { status: 'ready' }>[]): Promise<void> {
    const key = 'sessions'
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
      const outcome = await refreshSessions(cache, {
        repos: readyEntries.map((entry) => ({ id: entry.id, root: entry.path })),
        reader: params.sessionReader,
        claudeHome: params.claudeHome,
        now,
      })
      sessionsHealth = outcome.ok ? afterSuccess(sessionsHealth, 'sessions', now()) : afterFailure(sessionsHealth, 'sessions', now(), outcome.error ?? 'unknown error')
    } finally {
      inFlight.delete(key)
    }
  }

  function isDue(kind: SourceKind, repoId?: RepoId): boolean {
    const h = kind === 'sessions' ? sessionsHealth : repoId !== undefined ? ensureHealth(repoId)[kind] : sessionsHealth
    return nextDueAt(h, now()).getTime() <= now().getTime()
  }

  async function tick(request?: RefreshRequest): Promise<void> {
    if (stopped) return

    const currentReady = repositories.filter(isReady)
    const githubWillRun = currentReady.some((entry) => isDue('github', entry.id) || isForced(request, 'github', entry.id))
    if (typeof params.repositories === 'function' && (!hasListedRepositories || githubWillRun)) {
      repositories = await params.repositories()
      hasListedRepositories = true
    }

    const readyEntries = repositories.filter(isReady)

    if (isDue('sessions') || isForced(request, 'sessions')) {
      await runSessions(readyEntries)
    }

    for (const entry of readyEntries) {
      for (const kind of SOURCE_KINDS) {
        if (kind === 'sessions') continue
        if (isDue(kind, entry.id) || isForced(request, kind, entry.id)) {
          await runRepoSource(entry, kind)
        }
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    if (timer !== null) timer.clear()
    const readyEntries = repositories.filter(isReady)
    const candidates = [nextDueAt(sessionsHealth, now()).getTime()]
    for (const entry of readyEntries) {
      const h = ensureHealth(entry.id)
      candidates.push(nextDueAt(h.github, now()).getTime(), nextDueAt(h.worktrees, now()).getTime(), nextDueAt(h.denials, now()).getTime())
    }
    const earliest = Math.min(...candidates)
    const delay = Math.max(0, earliest - now().getTime())
    timer = setTimer(() => {
      void tick().then(() => {
        params.onSnapshot(buildSnapshot())
        scheduleNext()
      })
    }, delay)
  }

  scheduleNext()

  return {
    async refresh(request?: RefreshRequest): Promise<BoardSnapshot> {
      if (stopped) return latest
      await tick(request)
      const snap = buildSnapshot()
      params.onSnapshot(snap)
      scheduleNext()
      return snap
    },
    snapshot(): BoardSnapshot {
      return latest
    },
    stop(): void {
      stopped = true
      if (timer !== null) timer.clear()
      timer = null
    },
  }
}

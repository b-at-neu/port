import type { DispatchLedger, UnknownStreaks, RefreshMemo, ForceDispatch } from '@/types/tick'
import type { PipelineState, RefreshOutcome } from '@/types/state'
import type { StateEngine } from '@/types/offload'

// The only clock in main — one timer, rescheduled to the earliest `nextDueAt`. `schedule.ts` decides *when*; this file is the only place under `src/main/` allowed to name `setTimeout`.
import type { GhRunner } from '@/types/platform'
import type { GitRunner } from '@/types/platform'
import { readSessionState } from '@/main/sessions/adapter'
import type { RepoId } from '@/utils/repos'
import type { RepositoryEntry } from '@/utils/repos'
import { DEFAULT_POLL_POLICY, SOURCE_KINDS, initialHealth, isDeferred } from '@/types/board'
import type { BoardSnapshot, RepositoryHealth, SourceHealth, SourceKind } from '@/types/board'
import type { RepoDispatchStatus, RunStatesSnapshot } from '@/types/dispatch'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { autoPlanStatusOf } from '@/main/tick/auto-plan'

import type { EndedStage } from '@/types/tick'
import { buildDesktopTickEvent, recordTick as defaultRecordTick } from '@/main/trajectory/log'
import type { DesktopTickEvent } from '@/types/trajectory'
import type { RecordTickDeps } from '@/types/trajectory'
import { isReady } from '@/main/state/read'
import { afterFailure, afterSuccess, budgetedIntervalMs, deferredUntil, dueSources, nextDueAt } from '@/main/state/schedule'
import { createInProcessEngine } from '@/main/offload/engine'

import type { PipelineWatcher, RefreshRequest, TimerFactory, TimerHandle } from '@/types/state'

const defaultSetTimer: TimerFactory = (callback, ms) => {
  const handle = setTimeout(callback, ms)
  return { clear: () => clearTimeout(handle) }
}

/** Injected so `watcher.test.ts` never touches a real filesystem for the trajectory record. */
type RecordTickFn = (repoRoot: string, event: DesktopTickEvent, deps?: RecordTickDeps) => Promise<void>

interface CreatePipelineWatcherParams {
  /** A static list, or a provider re-invoked on the GitHub cadence, so a repository added or removed appears on the board without a restart. */
  readonly repositories: readonly RepositoryEntry[] | (() => Promise<readonly RepositoryEntry[]>)
  readonly onSnapshot: (snapshot: BoardSnapshot) => void
  /** Fired after `buildSnapshot()` on the timer path and in `refresh()` — never in `republish()`, so a dispatch pass never re-triggers itself off its own state change. */
  readonly onTick?: (snapshot: BoardSnapshot) => void
  /** Owns the source cache and every CPU-bound read. Defaults to an in-process engine built from `gh`/`git`/`sessionReader`/`claudeHome`, which the worker-backed one replaces in production. */
  readonly engine?: StateEngine
  readonly gh?: GhRunner
  readonly git?: GitRunner
  readonly sessionReader?: Parameters<typeof readSessionState>[0]['reader']
  readonly claudeHome?: string
  readonly now?: () => Date
  readonly setTimer?: TimerFactory
  readonly recordTick?: RecordTickFn
  /** Read fresh on every `buildSnapshot()`, never cached. Defaults to every repository reading paused. */
  readonly runStates?: (repoIds: readonly RepoId[]) => RunStatesSnapshot
  /** A dispatcher built after the watcher needs this same ledger/streak memo, never a second instance that would disagree with what the board just reported. */
  readonly ledger?: DispatchLedger
  readonly unknownStreaks?: UnknownStreaks
  /** Shared with the dispatcher's own observation pass, never a second instance that would disagree with what the dispatcher just wrote. */
  readonly refreshMemo?: RefreshMemo
  /** The Needs-you "Dispatch anyway" override — shared with the dispatcher's own consumption pass, never a second instance that would disagree on which entries are still live. */
  readonly forceDispatch?: ForceDispatch
  /** This repository's own dispatcher session's `started` tasks, as descriptions. `undefined` reads as `[]`. */
  readonly startedTasks?: (repoId: RepoId) => readonly string[]
  /** Read fresh inside `buildSnapshot()`, never cached. `undefined` reads as `[]`. */
  readonly dispatchStatus?: () => readonly RepoDispatchStatus[]
  /** `planTick`'s own `holdSessionRequired` input, read fresh per repository. `undefined` reads as `true` — the terminal-cockpit default, unchanged. */
  readonly holdSessionRequired?: (repoId: RepoId) => boolean
  /** `planTick`'s own `stageLiveness` input, read fresh per repository. `undefined` reads as `null` for every repository — byte-identical to today. */
  readonly stageLiveness?: (repoId: RepoId) => { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null
  /** `planTick`'s own `endedStages` input, read fresh per repository. `undefined` reads as `[]` for every repository — byte-identical to today. */
  readonly endedStages?: (repoId: RepoId) => readonly EndedStage[]
  /** The auto-planner's refused swaps, read fresh per repository. `undefined` reads as none. */
  readonly autoPlanRefused?: (repoId: RepoId) => ReadonlySet<number>
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
  const engine = params.engine ?? createInProcessEngine({ gh: params.gh, git: params.git, sessionReader: params.sessionReader, claudeHome: params.claudeHome, now })
  const githubCost = new Map<RepoId, number>()
  let projections: Promise<unknown> = Promise.resolve()
  const health = new Map<RepoId, RepositoryHealth>()
  let sessionsHealth: SourceHealth = initialHealth('sessions')
  const inFlight = new Set<string>()
  const active = new Map<string, Promise<void>>()
  const queued = new Map<string, Promise<void>>()
  let repositories: readonly RepositoryEntry[] = Array.isArray(params.repositories) ? params.repositories : []
  let hasListedRepositories = Array.isArray(params.repositories)
  let stopped = false
  let timer: TimerHandle | null = null
  // One process-scoped ledger, this watcher's whole lifetime — a restarted app gets a fresh one, so every in-flight item reads `no-record`, never a false reset.
  const ledger = params.ledger ?? createDispatchLedger()
  // Same lifetime and restart behaviour as `ledger` above.
  const unknownStreaks = params.unknownStreaks ?? createUnknownStreaks()
  // Same lifetime and restart behaviour as `ledger`/`unknownStreaks` above.
  const refreshMemo = params.refreshMemo ?? createRefreshMemo()
  const startedTasks = params.startedTasks ?? ((): readonly string[] => [])
  // Injectable the same way `gh`/`git`/`sessionReader` already are, so a test never touches a real filesystem for it.
  const recordTickFn: RecordTickFn = params.recordTick ?? defaultRecordTick
  const runStatesOf =
    params.runStates ??
    ((repoIds: readonly RepoId[]): RunStatesSnapshot => ({ store: { kind: 'loaded' }, repositories: repoIds.map((repoId) => ({ repoId, state: 'paused', since: null })) }))
  let latest: BoardSnapshot = {
    state: {
      repositories: [],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: now().toISOString() },
      readAt: now().toISOString(),
    },
    health: [],
    policy: DEFAULT_POLL_POLICY,
    tick: [],
    runStates: runStatesOf(repositories.map((entry) => entry.id)),
    nextWakeupAt: null,
    emittedAt: now().toISOString(),
    dispatch: params.dispatchStatus?.() ?? [],
    autoPlan: [],
  }

  const noRefusals: ReadonlySet<number> = new Set()
  const autoPlanOf = (tick: BoardSnapshot['tick'], dispatch: BoardSnapshot['dispatch']): BoardSnapshot['autoPlan'] => autoPlanStatusOf(tick, dispatch, (repoId) => params.autoPlanRefused?.(repoId) ?? noRefusals)

  function ensureHealth(repoId: RepoId): RepositoryHealth {
    const existing = health.get(repoId)
    if (existing) return existing
    const created: RepositoryHealth = { repoId, github: initialHealth('github'), sessions: sessionsHealth, worktrees: initialHealth('worktrees'), denials: initialHealth('denials') }
    health.set(repoId, created)
    return created
  }

  /** Shared by `scheduleNext()`'s `setTimeout` delay and `buildSnapshot()`'s `nextWakeupAt`, so the UI never announces a wakeup this watcher did not actually schedule. */
  function earliestDueAt(): Date {
    const readyEntries = repositories.filter(isReady)
    const candidates = [nextDueAt(sessionsHealth, now()).getTime()]
    for (const entry of readyEntries) {
      const h = ensureHealth(entry.id)
      candidates.push(nextDueAt(h.github, now()).getTime(), nextDueAt(h.worktrees, now()).getTime(), nextDueAt(h.denials, now()).getTime())
    }
    return new Date(Math.min(...candidates))
  }

  /** Serialized, so two overlapping refreshes never apply `planTick`'s ledger writes out of order. A failed projection keeps the last good board and resolves `null`, so the next tick is still scheduled. */
  function buildSnapshot(): Promise<BoardSnapshot | null> {
    const built = projections.then(composeSnapshot)
    projections = built.catch(() => undefined)
    return built
  }

  async function composeSnapshot(): Promise<BoardSnapshot | null> {
    const entries = repositories
    let state: PipelineState
    try {
      state = await engine.project({ repositories: entries })
    } catch (error) {
      console.error('[watcher] projection failed', error)
      return null
    }
    return assembleSnapshot(state)
  }

  function assembleSnapshot(state: PipelineState): BoardSnapshot {
    const readyEntries = repositories.filter(isReady)
    const healthList = readyEntries.map((entry) => {
      const h = ensureHealth(entry.id)
      return { ...h, sessions: sessionsHealth }
    })
    // One TickReport per ready repository, over the same PipelineState above, never a second poll or cadence.
    const readyIds = new Set(readyEntries.map((entry) => entry.id))
    // Read from config, never hardcoded; a miss here is a defect, not a runtime case.
    const cycleCapByRepo = new Map(readyEntries.map((entry) => [entry.id, entry.config.reviewCycleCap]))
    const checkDispositionsByRepo = new Map(readyEntries.map((entry) => [entry.id, entry.config.checkDispositions]))
    const tick = state.repositories
      .filter((repository) => readyIds.has(repository.repoId))
      .map((repository) => {
        const reviewCycleCap = cycleCapByRepo.get(repository.repoId)
        if (reviewCycleCap === undefined) throw new Error(`no reviewCycleCap for ready repository ${String(repository.repoId)}`)
        const checkDispositions = checkDispositionsByRepo.get(repository.repoId)
        if (checkDispositions === undefined) throw new Error(`no checkDispositions for ready repository ${String(repository.repoId)}`)
        return planTick({
          repository,
          ledger,
          unknownStreaks,
          nextDecisionAt: nextDueAt(ensureHealth(repository.repoId).github, now()),
          now,
          reviewCycleCap,
          startedTasks: startedTasks(repository.repoId),
          refreshMemo,
          checkDispositions,
          holdSessionRequired: params.holdSessionRequired?.(repository.repoId) ?? true,
          stageLiveness: params.stageLiveness?.(repository.repoId) ?? null,
          endedStages: params.endedStages?.(repository.repoId) ?? [],
          forceDispatch: params.forceDispatch,
        })
      })

    // Fire-and-forget, never part of the BoardSnapshot returned below — a write failure here must not change what the board renders. Skipped for a blind report.
    const entryById = new Map(readyEntries.map((entry) => [entry.id, entry] as const))
    for (const report of tick) {
      if (report.blind !== null) continue
      const entry = entryById.get(report.repoId)
      if (entry === undefined) continue
      void recordTickFn(entry.path, buildDesktopTickEvent({ repo: entry.config.repo, report, now }), { git: params.git })
    }

    const nextWakeupAt = stopped ? null : earliestDueAt().toISOString()
    const dispatch = params.dispatchStatus?.() ?? []
    latest = {
      state,
      health: healthList,
      policy: DEFAULT_POLL_POLICY,
      tick,
      runStates: runStatesOf(repositories.map((entry) => entry.id)),
      nextWakeupAt,
      emittedAt: now().toISOString(),
      dispatch,
      autoPlan: autoPlanOf(tick, dispatch),
    }
    return latest
  }

  /** The latest successful poll cost of every ready repository — the entry just written included. */
  function githubCosts(): readonly number[] {
    return repositories.filter(isReady).flatMap((entry) => {
      const cost = githubCost.get(entry.id)
      return cost === undefined ? [] : [cost]
    })
  }

  function track(key: string, read: Promise<void>): Promise<void> {
    const tracked = read.finally(() => {
      if (active.get(key) === tracked) active.delete(key)
    })
    active.set(key, tracked)
    return tracked
  }

  /** A forced read that finds one in flight waits for one follow-up read, shared by every forced request meanwhile; an unforced one just skips. */
  function runRepoSource(entry: Extract<RepositoryEntry, { status: 'ready' }>, kind: 'github' | 'worktrees' | 'denials', forced: boolean): Promise<void> {
    const key = `${entry.id}:${kind}`
    const outstanding = active.get(key)
    if (outstanding === undefined) return track(key, readRepoSource(entry, kind))
    if (!forced) return Promise.resolve()
    const waiting = queued.get(key)
    if (waiting !== undefined) return waiting
    const followUp = outstanding
      .catch(() => undefined)
      .then(() => {
        queued.delete(key)
        return track(key, readRepoSource(entry, kind))
      })
    queued.set(key, followUp)
    return followUp
  }

  async function readRepoSource(entry: Extract<RepositoryEntry, { status: 'ready' }>, kind: 'github' | 'worktrees' | 'denials'): Promise<void> {
    let outcome: RefreshOutcome
    if (kind === 'worktrees') {
      outcome = await engine.refreshWorktrees({ repoId: entry.id, repoRoot: entry.path })
    } else if (kind === 'denials') {
      outcome = await engine.refreshDenials({ repoId: entry.id, repoRoot: entry.path })
    } else {
      outcome = await engine.refreshGithub({ repoId: entry.id, repo: repoRefOf(entry), vocabulary: entry.config.vocabulary })
    }
    const current = ensureHealth(entry.id)
    const previous = current[kind]
    let updated: SourceHealth
    if (outcome.ok) {
      updated = afterSuccess(previous, kind, now())
      if (kind === 'github') {
        if (outcome.rateLimit) githubCost.set(entry.id, outcome.rateLimit.cost)
        if (outcome.rateLimit) updated = { ...updated, intervalMs: budgetedIntervalMs({ costs: githubCosts(), rateLimit: outcome.rateLimit, now: now() }) }
        // A known reset instant always beats a doubled guess, even on a success whose own window reports low headroom.
        const defer = deferredUntil(outcome.rateLimit ?? null, null)
        if (defer !== null) updated = { ...updated, deferredUntil: defer }
      }
    } else {
      updated = afterFailure(previous, kind, now(), outcome.error ?? 'unknown error', kind === 'github' ? deferredUntil(outcome.rateLimit ?? null, outcome.failureKind ?? null) : null)
    }
    health.set(entry.id, { ...current, [kind]: updated })
  }

  async function runSessions(readyEntries: readonly Extract<RepositoryEntry, { status: 'ready' }>[]): Promise<void> {
    const key = 'sessions'
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
      const outcome = await engine.refreshSessions({ repos: readyEntries.map((entry) => ({ id: entry.id, root: entry.path })) })
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
      // `dueSources` sorts github last, so a cheap local read due the same tick never waits behind it.
      const entryHealth = ensureHealth(entry.id)
      const toRun = new Set<SourceKind>(dueSources(entryHealth, now()))
      for (const kind of SOURCE_KINDS) {
        if (kind === 'sessions' || !isForced(request, kind, entry.id)) continue
        if (kind === 'github' && isDeferred(entryHealth.github, now())) continue
        toRun.add(kind)
      }
      const ordered = [...toRun].filter((kind) => kind !== 'sessions').sort((a, b) => (a === 'github' ? 1 : b === 'github' ? -1 : 0))
      for (const kind of ordered) {
        await runRepoSource(entry, kind, isForced(request, kind, entry.id))
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    if (timer !== null) timer.clear()
    const delay = Math.max(0, earliestDueAt().getTime() - now().getTime())
    timer = setTimer(() => {
      void tick()
        .then(buildSnapshot)
        .then((snap) => {
          if (snap !== null) {
            params.onSnapshot(snap)
            params.onTick?.(snap)
          }
          scheduleNext()
        })
    }, delay)
  }

  scheduleNext()

  return {
    async refresh(request?: RefreshRequest): Promise<BoardSnapshot> {
      if (stopped) return latest
      await tick(request)
      const snap = await buildSnapshot()
      if (snap !== null) {
        params.onSnapshot(snap)
        params.onTick?.(snap)
      }
      scheduleNext()
      return snap ?? latest
    },
    snapshot(): BoardSnapshot {
      return latest
    },
    stop(): void {
      stopped = true
      if (timer !== null) timer.clear()
      timer = null
      // The honest rendering of "no wakeup scheduled" — applied to the cached snapshot directly, since a stopped watcher never rebuilds one.
      latest = { ...latest, nextWakeupAt: null }
    },
    republish(): void {
      if (stopped) return
      const dispatch = params.dispatchStatus?.() ?? []
      latest = { ...latest, dispatch, autoPlan: autoPlanOf(latest.tick, dispatch), emittedAt: now().toISOString() }
      params.onSnapshot(latest)
    },
  }
}

// The app's own dispatch loop: turns a BoardSnapshot into real stage-session launches through a
// StageLauncher seam. `consider` is the one entry point main/ipc.ts wires to `onTick`.
import type { BoardSnapshot } from '../../shared/board/types'
import type { BudgetNote, BudgetStatus, DispatchOwner, DispatcherState, ObservationRecord, RepoDispatchStatus } from '../../shared/dispatch/types'
import { RUN_TARGET } from '../../shared/dispatch/types'
import type { RunState } from '../../shared/dispatch/types'
import type { RepoId } from '../../shared/repos'
import type { HostedStore } from '../hosting/store'
import type { SessionKey } from '../../shared/hosting/types'
import type { ReadyEntry } from '../actions/apply'
import type { ApplyObservationParams, ApplyObservationResult } from '../actions/observe'
import type { EscalateToHumanParams, EscalateToHumanResult } from '../actions/escalate'
import type { RegistryDeps } from '../registry'
import type { ReposListResponse } from '../../shared/ipc'
import type { DispatchLedger, RefreshMemo } from '../tick/ledger'
import { dispatchableFrom, observableFrom } from '../tick/dispatchable'
import type { ReadOwnershipParams, TakeOwnershipParams, TakeOwnershipResult } from './ownership'
import type { OwnershipRead } from './ownership'
import type { FetchItemsByNumberParams } from '../github/adapter'
import type { ItemsByNumberFetch } from '../../shared/github/types'
import { labelName } from '../../shared/labels/vocabulary'
import { runObservationPass } from './observe-pass'
import { commentFailureMessage, selectDispatches, survived } from './select'
import { budgetLiveSets, budgetRoute, escalationBody } from './budget'
import type { BudgetGate } from './budget-gate'
import { boundRecords, freeSlots, refreshRecords } from './launch'
import type { StageLauncher, StageRecord } from './launch'
import type { StageSessionSummary } from './quit'
import type { TickActionable, TickReport } from '../../shared/tick/types'
import type { StageOutcome } from '../../shared/hosting/stage'

const RECENT_LIMIT = 20
const NOTE_LIMIT = 20

/** Byte-identical to the pipeline skill's own "Dispatching" block, pinned by desktop-dispatch.ts. */
export const DISPATCH_PROMPT = 'Run your pipeline stage for #<n>. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
export const REFRESH_PROMPT = 'Run your pipeline stage for pull request #<n> in refresh mode.'

/** `launch.ts`'s own `StageLaunchRequest.prompt` is filled from this, never re-derived at the launcher. */
export function promptFor(actionable: Pick<TickActionable, 'trigger' | 'number'>): string {
  const n = String(actionable.number)
  return actionable.trigger === 'refreshBranch' ? REFRESH_PROMPT.replace('<n>', n) : DISPATCH_PROMPT.replace('<n>', n)
}

export interface CreateDispatcherParams {
  readonly store: HostedStore
  readonly ledger: DispatchLedger
  /** `null` is the honest state until a real launcher exists; a candidate sits visibly at `no-launcher`. */
  readonly launch: StageLauncher | null
  /** Read fresh every pass, never cached. */
  readonly runState: (repoId: RepoId) => RunState
  readonly readOwnership: (params: ReadOwnershipParams) => Promise<OwnershipRead>
  /** The re-take-on-relaunch rule: a persisted `run`/`draining` state with an `absent` ownership
   *  record takes ownership itself. */
  readonly takeOwnership: (params: TakeOwnershipParams) => Promise<TakeOwnershipResult>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly listRepositories: (registryDeps: RegistryDeps) => Promise<ReposListResponse>
  readonly registryDeps: RegistryDeps
  readonly budget: BudgetGate
  readonly escalate: (params: EscalateToHumanParams) => Promise<EscalateToHumanResult>
  readonly writeObservation: (params: ApplyObservationParams) => Promise<ApplyObservationResult>
  readonly refreshMemo: RefreshMemo
  readonly dirs: { readonly audit: string; readonly scratch: string }
  readonly onChange: () => void
  readonly now: () => Date
}

export interface Dispatcher {
  /** Considers every ready repository, at most one pass each at a time. Never throws: a failure
   *  in one repository's pass is reported on its own status, never allowed to stop the others. */
  consider(snapshot: BoardSnapshot): Promise<void>
  status(): readonly RepoDispatchStatus[]
  /** `true` only when this loop found a `started` record for `(repoId, number)` and closing it did not throw. */
  stopFor(repoId: RepoId, number: number): Promise<boolean>
  /** Closes every remaining live stage session in a repository. */
  standDown(repoId: RepoId): Promise<boolean>
  liveStages(repoId: RepoId): readonly string[]
  /** Every live stage session across every repository, for the quit guard. */
  liveStageSessions(): readonly StageSessionSummary[]
  /** Stops new launches — called before `closeAll()` on quit. */
  shutdown(): void
  /** Records a stage launcher's hand-back classification against its matching record, by session key. A no-op if the key is not tracked. */
  recordOutcome(repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome): void
  /** `true` unless this app currently owns `repoId` — an unread repository (`'none'`) holds, the fail direction for `SESSION REQUIRED`. */
  holdsSessionRequired(repoId: RepoId): boolean
}

interface RepoDispatcherState {
  records: readonly StageRecord[]
  owner: DispatchOwner
  dispatcherState: DispatcherState
  runState: RunState
  ownedSince: string | null
  unreadableMessage: string | null
  budgetReset: boolean
  budgetHolds: Map<number, number>
  budget: BudgetStatus | null
  observed: ObservationRecord[]
  observedWriteAt: Map<number, string>
}

function emptyRepoState(): RepoDispatcherState {
  return {
    records: [],
    owner: 'none',
    dispatcherState: { kind: 'idle' },
    runState: 'paused',
    ownedSince: null,
    unreadableMessage: null,
    budgetReset: false,
    budgetHolds: new Map(),
    budget: null,
    observed: [],
    observedWriteAt: new Map(),
  }
}

function ownerOf(ownership: OwnershipRead): DispatchOwner {
  switch (ownership.kind) {
    case 'absent':
      return 'none'
    case 'app':
      return 'app'
    case 'terminal':
      return 'terminal'
    case 'unreadable':
      return 'unreadable'
  }
}

export function createDispatcher(deps: CreateDispatcherParams): Dispatcher {
  const repoStates = new Map<RepoId, RepoDispatcherState>()
  const repoNames = new Map<RepoId, string>()
  const inFlight = new Set<RepoId>()
  let stopped = false
  // Serializes every repository's own launch section so two repositories never race for the same free slot.
  let launchQueue: Promise<void> = Promise.resolve()

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = launchQueue.then(fn)
    launchQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function stateFor(repoId: RepoId): RepoDispatcherState {
    const existing = repoStates.get(repoId)
    if (existing !== undefined) return existing
    const created = emptyRepoState()
    repoStates.set(repoId, created)
    return created
  }

  function pushRecord(repoId: RepoId, record: StageRecord): void {
    const state = stateFor(repoId)
    state.records = boundRecords([...state.records, record], RECENT_LIMIT)
  }

  function report(repoId: RepoId, owner: DispatchOwner, dispatcherState: DispatcherState, runState: RunState): void {
    const state = stateFor(repoId)
    state.owner = owner
    state.dispatcherState = dispatcherState
    state.runState = runState
    deps.onChange()
  }

  function activeOrIdle(repoId: RepoId): DispatcherState {
    const records = stateFor(repoId).records
    return records.length > 0
      ? { kind: 'active', recent: records.map((r) => ({ agent: r.agent, number: r.number, kind: r.kind, state: r.state, at: r.at, detail: r.detail, outcome: r.outcome })) }
      : { kind: 'idle' }
  }

  function recordOutcome(repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome): void {
    const state = repoStates.get(repoId)
    if (state === undefined) return
    const idx = state.records.findIndex((r) => r.sessionKey === sessionKey)
    if (idx === -1) return
    const next = [...state.records]
    // Never reassigned, so a non-null `Infinity`-bounds index access stays well-typed.
    const existing = next[idx]
    if (existing === undefined) return
    next[idx] = { ...existing, outcome }
    state.records = next
    deps.onChange()
  }

  function holdsSessionRequired(repoId: RepoId): boolean {
    return stateFor(repoId).owner !== 'app'
  }

  async function considerRepo(entry: ReadyEntry, tick: TickReport | undefined, viewer: string | null): Promise<void> {
    if (stopped) return
    if (inFlight.has(entry.id)) return
    inFlight.add(entry.id)
    repoNames.set(entry.id, entry.config.repo)
    try {
      const runState = deps.runState(entry.id)
      let ownership = await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })

      // A persisted run/draining state with an absent record means the app restarted; it takes
      // ownership back rather than sitting idle until the operator clicks Run again.
      if (ownership.kind === 'absent' && (runState === RUN_TARGET.run || runState === RUN_TARGET.drain)) {
        const taken = await deps.takeOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
        if (taken.ok) ownership = await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      }

      const owner = ownerOf(ownership)
      const state = stateFor(entry.id)
      state.ownedSince = ownership.kind === 'app' || ownership.kind === 'terminal' ? ownership.since : null
      state.unreadableMessage = ownership.kind === 'unreadable' ? ownership.message : null
      state.records = refreshRecords(state.records, (sessionKey) => deps.store.snapshotOf(sessionKey))

      const anyLive = state.records.some((r) => r.state === 'started')
      if (entry.config.commands.budget !== null && (owner === 'app' || anyLive)) {
        if (!state.budgetReset) {
          const resetResult = await deps.budget.reset(entry)
          if (resetResult.ok) {
            state.budgetReset = true
          } else if (owner === 'app') {
            report(entry.id, owner, { kind: 'budget-unavailable', message: resetResult.message }, runState)
            return
          }
        }
        if (state.budgetReset) {
          const sets = budgetLiveSets(state.records)
          const sweepResult = await deps.budget.sweep(entry, sets)
          state.budget = { line: sweepResult.line, problem: sweepResult.problem, notes: state.budget?.notes ?? [] }
        }
      }

      if (owner !== 'app') {
        report(entry.id, owner, { kind: 'idle' }, runState)
        return
      }

      if (tick === undefined || tick.blind !== null || viewer === null) {
        report(entry.id, owner, activeOrIdle(entry.id), runState)
        return
      }

      // The observation pass is independent of whatever dispatches below.
      const observable = observableFrom(tick, runState)
      if (observable.length > 0) {
        const repoState = snapshotRepoState(entry.id)
        if (repoState !== undefined) {
          await runObservationPass(entry, observable, repoState, state, {
            writeObservation: deps.writeObservation,
            refreshMemo: deps.refreshMemo,
            dirs: deps.dirs,
            now: deps.now,
            onChange: deps.onChange,
          })
        }
      }

      const dispatchable = dispatchableFrom(tick, runState)
      const liveNumbers = new Set(state.records.filter((r) => r.state === 'started').map((r) => r.number))
      const notAlreadyLive = dispatchable.filter((c) => !liveNumbers.has(c.number))
      const candidates = selectDispatches({ dispatchable: notAlreadyLive, recent: state.records, now: deps.now() })
      if (candidates.length === 0) {
        report(entry.id, owner, activeOrIdle(entry.id), runState)
        return
      }

      if (deps.launch === null) {
        report(entry.id, owner, { kind: 'no-launcher' }, runState)
        return
      }

      const reread = await deps.fetchItemsByNumber({ repo: { owner: entry.config.owner, name: entry.config.name }, numbers: candidates.map((c) => c.number) })
      if (!reread.ok) return // a failed re-read dispatches nothing this pass

      const resolvedByNumber = new Map(reread.resolved.map((r) => [r.number, r] as const))
      const survivors = candidates.filter((c) => {
        const resolved = resolvedByNumber.get(c.number)
        return resolved !== undefined && !reread.unavailable.includes(c.number) && survived(resolved, c, entry.config.vocabulary, viewer)
      })
      if (survivors.length === 0) {
        report(entry.id, owner, activeOrIdle(entry.id), runState)
        return
      }

      await launchSurvivors(entry, survivors, state, owner, runState, viewer)
    } finally {
      inFlight.delete(entry.id)
    }
  }

  async function launchSurvivors(entry: ReadyEntry, survivors: readonly TickActionable[], state: RepoDispatcherState, owner: DispatchOwner, runState: RunState, viewer: string): Promise<void> {
    const launch = deps.launch
    if (launch === null) return

    let gated: readonly TickActionable[] = survivors
    const notes: BudgetNote[] = []
    if (entry.config.commands.budget !== null) {
      const kept: TickActionable[] = []
      for (const candidate of survivors) {
        const result = await deps.budget.check(entry, candidate, entry.config.models[candidate.agent])
        if (!result.ok) {
          notes.push({ kind: 'gate-failed', number: candidate.number, message: result.message })
          continue
        }
        const priorHolds = state.budgetHolds.get(candidate.number) ?? 0
        const route = budgetRoute(result.verdict, priorHolds)
        if (route.holds === 0) state.budgetHolds.delete(candidate.number)
        else state.budgetHolds.set(candidate.number, route.holds)

        if (route.action === 'dispatch') {
          kept.push(candidate)
          if (priorHolds > 0) notes.push({ kind: 'held-dispatched', number: candidate.number })
          continue
        }
        if (route.action === 'hold') {
          notes.push({ kind: 'held', number: candidate.number, line: result.line })
          continue
        }
        await escalateOverBudget(entry, candidate, result.line, notes, viewer)
      }
      gated = kept
      state.budget = { line: state.budget?.line ?? null, problem: state.budget?.problem ?? null, notes: notes.length > NOTE_LIMIT ? notes.slice(notes.length - NOTE_LIMIT) : notes }
    }

    if (gated.length === 0) {
      report(entry.id, owner, activeOrIdle(entry.id), runState)
      return
    }

    let waiting = 0
    await serialize(async () => {
      const limit = (await deps.store.capacity()).limit
      for (const candidate of gated) {
        if (stopped) break
        if (deps.runState(entry.id) !== RUN_TARGET.run) {
          waiting += 1
          continue
        }
        const free = freeSlots(limit, deps.store.list())
        if (free <= 0) {
          waiting += 1
          continue
        }
        try {
          const result = await launch.launch({ entry, agent: candidate.agent, number: candidate.number, kind: candidate.kind, trigger: candidate.trigger, model: entry.config.models[candidate.agent], prompt: promptFor(candidate) })
          const at = deps.now().toISOString()
          if (result.ok) {
            if (stopped) {
              void deps.store.close(result.sessionKey)
              continue
            }
            pushRecord(entry.id, { sessionKey: result.sessionKey, agent: candidate.agent, number: candidate.number, kind: candidate.kind, trigger: candidate.trigger, state: 'started', at, detail: null, outcome: null })
            deps.ledger.record(entry.id, candidate.number)
          } else if (result.kind === 'at-capacity') {
            waiting += 1
          } else {
            pushRecord(entry.id, { sessionKey: null, agent: candidate.agent, number: candidate.number, kind: candidate.kind, trigger: candidate.trigger, state: 'failed', at, detail: result.message, outcome: null })
          }
        } catch (error) {
          const at = deps.now().toISOString()
          const message = error instanceof Error ? error.message : String(error)
          pushRecord(entry.id, { sessionKey: null, agent: candidate.agent, number: candidate.number, kind: candidate.kind, trigger: candidate.trigger, state: 'failed', at, detail: message, outcome: null })
        }
      }
    })

    const limit = (await deps.store.capacity()).limit
    if (waiting > 0) report(entry.id, owner, { kind: 'at-capacity', limit, waiting }, runState)
    else report(entry.id, owner, activeOrIdle(entry.id), runState)
  }

  async function escalateOverBudget(entry: ReadyEntry, candidate: TickActionable, line: string, notes: BudgetNote[], viewer: string): Promise<void> {
    const needsHumanLabel = labelName(entry.config.vocabulary, 'needsHuman') ?? 'needsHuman'
    const triggerLabel = labelName(entry.config.vocabulary, candidate.trigger) ?? candidate.trigger
    const escalation = await deps.escalate({
      entry,
      kind: candidate.kind,
      number: candidate.number,
      trigger: candidate.trigger,
      viewer,
      body: escalationBody(line),
      action: 'budget-escalate',
      auditDir: deps.dirs.audit,
      scratchDir: deps.dirs.scratch,
    })
    if (escalation.labels.kind === 'applied') {
      notes.push({ kind: 'escalated', number: candidate.number, needsHumanLabel, commentFailedMessage: commentFailureMessage(escalation.comment) })
    } else {
      notes.push({ kind: 'escalation-failed', number: candidate.number, needsHumanLabel, triggerLabel, outcome: escalation.labels })
    }
  }

  // Resolved lazily from the most recent consider() call's own snapshot, as a tiny cache.
  let lastRepoStates: BoardSnapshot['state']['repositories'] = []
  function snapshotRepoState(repoId: RepoId): Extract<BoardSnapshot['state']['repositories'][number], { readonly ok: true }> | undefined {
    const found = lastRepoStates.find((r) => r.ok && r.repoId === repoId)
    return found?.ok ? found : undefined
  }

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    if (stopped) return
    lastRepoStates = snapshot.state.repositories
    const list = await deps.listRepositories(deps.registryDeps)
    if (!list.ok) return
    const readyEntries = list.repositories.filter((entry): entry is ReadyEntry => 'config' in entry)
    const tickByRepo = new Map(snapshot.tick.map((t) => [t.repoId, t] as const))
    const viewerByRepo = new Map(snapshot.state.repositories.filter((r): r is Extract<typeof r, { readonly ok: true }> => r.ok).map((r) => [r.repoId, r.viewer] as const))
    await Promise.all(readyEntries.map((entry) => considerRepo(entry, tickByRepo.get(entry.id), viewerByRepo.get(entry.id) ?? null)))
  }

  function status(): readonly RepoDispatchStatus[] {
    return [...repoStates.entries()].map(([repoId, s]) => ({
      repoId,
      owner: s.owner,
      state: s.dispatcherState,
      runState: s.runState,
      ownedSince: s.ownedSince,
      unreadableMessage: s.unreadableMessage,
      budget: s.budget,
      observed: s.observed,
    }))
  }

  function liveStages(repoId: RepoId): readonly string[] {
    const state = repoStates.get(repoId)
    if (state === undefined) return []
    return state.records.filter((r) => r.state === 'started').map((r) => `${r.agent} #${String(r.number)}`)
  }

  function liveStageSessions(): readonly StageSessionSummary[] {
    const summaries: StageSessionSummary[] = []
    for (const [repoId, state] of repoStates.entries()) {
      const repoName = repoNames.get(repoId) ?? String(repoId)
      for (const record of state.records) {
        if (record.state === 'started') summaries.push({ agent: record.agent, number: record.number, trigger: record.trigger, repoName })
      }
    }
    return summaries
  }

  async function stopFor(repoId: RepoId, number: number): Promise<boolean> {
    const state = repoStates.get(repoId)
    if (state === undefined) return false
    const record = state.records.find((r) => r.number === number && r.state === 'started' && r.sessionKey !== null)
    if (record === undefined || record.sessionKey === null) return false
    const result = await deps.store.close(record.sessionKey)
    if (result.ok) deps.onChange()
    return result.ok
  }

  async function standDown(repoId: RepoId): Promise<boolean> {
    const state = repoStates.get(repoId)
    if (state === undefined) return false
    const live = state.records.filter((r): r is StageRecord & { sessionKey: SessionKey } => r.state === 'started' && r.sessionKey !== null)
    if (live.length === 0) return false
    let allOk = true
    for (const record of live) {
      const result = await deps.store.close(record.sessionKey)
      if (!result.ok) allOk = false
    }
    deps.onChange()
    return allOk
  }

  function shutdown(): void {
    stopped = true
  }

  return { consider, status, stopFor, standDown, liveStages, liveStageSessions, shutdown, recordOutcome, holdsSessionRequired }
}

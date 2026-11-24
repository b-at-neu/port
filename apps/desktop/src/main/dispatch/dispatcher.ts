// The app's own dispatch loop: turns a BoardSnapshot into real stage-session launches through a
// StageLauncher seam. `consider` is the one entry point main/ipc.ts wires to `onTick`.
import type { ReadyEntry } from '@/types/actions'
import type { BoardSnapshot } from '@/types/board'
import type { CreateDispatcherParams, Dispatcher, DispatchOwner, DispatcherState, RepoDispatchStatus, RunState, StageRecord, StageSnapshot } from '@/types/dispatch'
import { RUN_TARGET } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { StageDenial, InterruptedStage } from '@/types/stage'
import type { StagePlanFile } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { EndedStage } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { dispatchableFrom, observableFrom } from '@/main/pipeline/tick/dispatchable'
import { createRaiser, endedIntents, stageSnapshotOf } from '@/main/pipeline/incidents/raise'
import { budgetLiveSets, sumCostUsd } from '@/main/dispatch/budget'
import { createStageHandoff } from '@/main/dispatch/handoff'
import { createLaunchSection, survived } from '@/main/dispatch/launch'
import { runObservationPass } from '@/main/dispatch/observe'
import {
  activeOrIdle,
  boundRecords,
  emptyRepoState,
  endedStagesOf,
  liveStageSessionsOf,
  liveStagesOf,
  newStageRecord,
  ownerOf,
  refreshRecords,
  selectDispatches,
  stageLivenessOf,
  statusOf,
} from '@/main/dispatch/records'
import type { RepoDispatcherState } from '@/main/dispatch/records'

const RECENT_LIMIT = 20

export function createDispatcher(deps: CreateDispatcherParams): Dispatcher {
  const repoStates = new Map<RepoId, RepoDispatcherState>()
  const repoNames = new Map<RepoId, string>()
  const raise = createRaiser(deps.recordIncident, (repoId) => repoNames.get(repoId))
  const inFlight = new Set<RepoId>()
  const pending = new Map<RepoId, ReadyEntry>()
  let stopped = false
  // Serializes every repository's own launch section so two repositories never race for the same free slot.
  let launchQueue: Promise<void> = Promise.resolve()
  const handoff = createStageHandoff({ write: (p) => deps.stageLabels.transition({ ...p, snapshot: snapshotOf(p.entry.id, p.record.number) }), auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch, onChange: deps.onChange, recordIncident: deps.recordIncident, requestRead: deps.requestRead, now: deps.now })
  const launching = createLaunchSection({ deps, raise, isStopped: () => stopped, serialize, pushRecord, report, itemsOf: (repoId) => snapshotRepoState(repoId)?.items ?? [] })

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

  function recordOutcome(repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome, plan: StagePlanFile | null): void {
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
    for (const intent of endedIntents(existing, outcome, deps.now().getTime())) raise(repoId, existing, intent, { kind: outcome.kind })
    deps.onChange()
    // A newer session on the same ticket owns it now, so this older outcome writes no label.
    if (next.some((r) => r.number === existing.number && r.state === 'started' && r.at > existing.at)) return
    handoff.settle(repoId, { ...existing, sessionKey }, outcome, plan)
  }
  /** A resumed session settles labels like a launched one; it joins the records as `started`. */
  function trackResumed(repoId: RepoId, sessionKey: SessionKey, entry: InterruptedStage): void {
    pushRecord(repoId, newStageRecord(entry, 'started', deps.now().toISOString(), sessionKey, null))
  }
  function recordResumedTurn(repoId: RepoId, sessionKey: SessionKey): void {
    const record = repoStates.get(repoId)?.records.find((r) => r.sessionKey === sessionKey)
    if (record !== undefined) handoff.resumedTurn(repoId, { ...record, sessionKey })
  }
  function holdsSessionRequired(repoId: RepoId): boolean {
    return stateFor(repoId).owner !== 'app'
  }
  function recordDenial(repoId: RepoId, denial: StageDenial): void {
    deps.denials.record(denial)
    deps.onChange()
  }
  function dismissDenial(repoId: RepoId, id: string): void {
    deps.denials.dismiss(repoId, id)
    deps.onChange()
  }
  function clearDenialsFor(repoId: RepoId, rule: string): void {
    deps.denials.clearRule(repoId, rule)
    deps.onChange()
  }

  /** A request made during a pass is coalesced into one follow-up pass on the newest snapshot, never dropped. */
  async function considerRepo(entry: ReadyEntry): Promise<void> {
    if (stopped) return
    if (inFlight.has(entry.id)) {
      pending.set(entry.id, entry)
      return
    }
    inFlight.add(entry.id)
    await passRepo(entry)
    const next = pending.get(entry.id)
    pending.delete(entry.id)
    if (next !== undefined) await considerRepo(next)
  }

  /** Reads its tick and viewer when the pass starts, never from the snapshot that requested it; releases the in-flight mark itself. */
  async function passRepo(entry: ReadyEntry): Promise<void> {
    repoNames.set(entry.id, entry.config.repo)
    const tick = lastSnapshot?.tick.find((t) => t.repoId === entry.id)
    const viewer = snapshotRepoState(entry.id)?.viewer ?? null
    try {
      const runState = deps.runState(entry.id)
      let ownership = await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo })

      // A persisted run/draining state with an absent record means the app restarted; it takes
      // ownership back rather than sitting idle until the operator clicks Run again.
      if (ownership.kind === 'absent' && (runState === RUN_TARGET.run || runState === RUN_TARGET.drain)) {
        const taken = await deps.takeOwnership({ repoRoot: entry.path, repo: entry.config.repo })
        if (taken.ok) ownership = await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo })
      }

      const owner = ownerOf(ownership)
      const state = stateFor(entry.id)
      state.ownedSince = ownership.kind === 'app' ? ownership.since : null
      state.unreadableMessage = ownership.kind === 'unreadable' ? ownership.message : null
      state.records = refreshRecords(state.records, (sessionKey) => deps.store.snapshotOf(sessionKey), deps.now().toISOString())

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
          state.budget = { line: sweepResult.line, problem: sweepResult.problem, notes: state.budget?.notes ?? [], costUsd: sumCostUsd(state.records) }
        }
      }

      if (owner !== 'app') {
        report(entry.id, owner, { kind: 'idle' }, runState)
        return
      }

      handoff.remember(entry)
      await handoff.retryPending(entry.id)

      if (tick === undefined || tick.blind !== null || viewer === null) {
        report(entry.id, owner, activeOrIdle(state), runState)
        return
      }

      // The observation pass is independent of whatever dispatches below.
      const observable = observableFrom(tick, runState)
      if (observable.length > 0) {
        const repoState = snapshotRepoState(entry.id)
        if (repoState !== undefined) {
          await runObservationPass(entry, observable, repoState, state, {
            writeObservation: deps.writeObservation,
            transition: deps.stageLabels.transition,
            rerunChecks: deps.rerunChecks,
            rerunMemo: deps.rerunMemo,
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
        report(entry.id, owner, activeOrIdle(state), runState)
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
        return resolved !== undefined && !reread.unavailable.includes(c.number) && survived(resolved, c, entry.config.vocabulary, viewer, deps.stateLabels(entry.id, c.kind, c.number, entry.config.vocabulary))
      })
      if (survivors.length === 0) {
        report(entry.id, owner, activeOrIdle(state), runState)
        return
      }

      await launching.launchSurvivors({ entry, survivors, resolvedByNumber, state, owner, runState, viewer })
    } finally {
      inFlight.delete(entry.id)
    }
  }

  // The most recent consider() call's own snapshot, the one a pass reads when it starts.
  let lastSnapshot: BoardSnapshot | null = null
  function snapshotRepoState(repoId: RepoId): Extract<BoardSnapshot['state']['repositories'][number], { readonly ok: true }> | undefined {
    const found = lastSnapshot?.state.repositories.find((r) => r.ok && r.repoId === repoId)
    return found?.ok ? found : undefined
  }
  const snapshotOf = (repoId: RepoId, number: number): StageSnapshot => stageSnapshotOf(snapshotRepoState(repoId), number)

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    if (stopped) return
    lastSnapshot = snapshot
    const list = await deps.listRepositories(deps.registryDeps)
    if (!list.ok) return
    const readyEntries = list.repositories.filter((entry): entry is ReadyEntry => 'config' in entry)
    await Promise.all(readyEntries.map((entry) => considerRepo(entry)))
  }

  const interruptedOf = (repoId: RepoId): readonly InterruptedStage[] => deps.interrupted?.(repoId) ?? []

  function status(): readonly RepoDispatchStatus[] {
    return statusOf(repoStates, (repoId) => deps.denials.list(repoId), interruptedOf)
  }
  function liveStages(repoId: RepoId): readonly string[] {
    return liveStagesOf(repoStates.get(repoId))
  }
  function stageLiveness(repoId: RepoId): { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null {
    return stageLivenessOf(stateFor(repoId), handoff.pendingNumbers(repoId), interruptedOf(repoId), deps.now())
  }
  function endedStages(repoId: RepoId): readonly EndedStage[] {
    return endedStagesOf(repoStates.get(repoId)?.records ?? [], (sessionKey) => handoff.resultFor(sessionKey))
  }
  function liveStageSessions() {
    return liveStageSessionsOf(repoStates, (repoId) => repoNames.get(repoId) ?? String(repoId))
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

  return { consider, status, stopFor, standDown, liveStages, stageLiveness, endedStages, liveStageSessions, shutdown, recordOutcome, recordResumedTurn, trackResumed, holdsSessionRequired, recordDenial, dismissDenial, clearDenialsFor }
}

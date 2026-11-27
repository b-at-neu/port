// The app's own dispatch loop: turns a BoardSnapshot into real stage-session launches through the
// stage launcher. `consider` is the one entry point main/ipc.ts wires to `onTick`.
import type { ReadyEntry } from '@/types/actions'
import type { BoardSnapshot } from '@/types/board'
import type { Dispatcher, DispatchOwner, DispatcherState, RepoDispatchStatus, RunState, StageRecord } from '@/types/dispatch'
import { RUN_TARGET } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { StagePlanFile } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { EndedStage } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { isReadyEntry } from '@/main/repos'
import { readOwnership, takeOwnership } from '@/main/repos/ownership'
import { dispatchableFrom, observableFrom } from '@/main/pipeline/tick/dispatchable'
import { createRaiser, endedIntents, stageSnapshotOf } from '@/main/pipeline/incidents/raise'
import { budgetLiveSets, sumCostUsd } from '@/main/dispatch/budget'
import { budgetReset, budgetSweep } from '@/main/dispatch/budget-gate'
import type { DispatchContext } from '@/main/dispatch/context'
import { createStageHandoff } from '@/main/dispatch/handoff'
import { budgetGated, launchGated, survived } from '@/main/dispatch/launch'
import { runObservationPass } from '@/main/dispatch/observe'
import { activeOrIdle, boundRecords, emptyRepoState, endedStagesOf, liveStageSessionsOf, liveStagesOf, ownerOf, selectDispatches, stageLivenessOf, statusOf, syncChanges } from '@/main/dispatch/records'
import type { RepoDispatcherState } from '@/main/dispatch/records'

const RECENT_LIMIT = 20

export function createDispatcher(ctx: DispatchContext): Dispatcher {
  const runs = ctx.stores.runs
  const repoStates = new Map<RepoId, RepoDispatcherState>()
  const repoNames = new Map<RepoId, string>()
  const raise = createRaiser(ctx.stores.incidentLog.record, (repoId) => repoNames.get(repoId))
  const inFlight = new Set<RepoId>()
  const pending = new Map<RepoId, ReadyEntry>()
  let stopped = false
  // Serializes every repository's own launch section so two repositories never race for the same free slot.
  let launchQueue: Promise<void> = Promise.resolve()
  const handoff = createStageHandoff(ctx, (repoId, number) => stageSnapshotOf(snapshotRepoState(repoId), number))

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

  /** The repository's newest runs as the loop reads them, never more than `RECENT_LIMIT`. */
  function recordsOf(repoId: RepoId): readonly StageRecord[] {
    return boundRecords(runs.records(repoId), RECENT_LIMIT)
  }

  function report(repoId: RepoId, owner: DispatchOwner, dispatcherState: DispatcherState, runState: RunState): void {
    const state = stateFor(repoId)
    state.owner = owner
    state.dispatcherState = dispatcherState
    state.runState = runState
    ctx.live.watcher.republish()
  }

  function recordOutcome(repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome, plan: StagePlanFile | null): void {
    const records = runs.records(repoId)
    const existing = records.find((r) => r.sessionKey === sessionKey)
    if (existing === undefined) return
    for (const intent of endedIntents(existing, outcome, ctx.clock.now().getTime())) raise(repoId, existing, intent, { kind: outcome.kind })
    ctx.live.watcher.republish()
    // A newer session on the same ticket owns it now, so this older outcome writes no label.
    if (records.some((r) => r.number === existing.number && r.state === 'started' && r.at > existing.at)) return
    handoff.settle(repoId, { ...existing, sessionKey }, outcome, plan)
  }
  function recordResumedTurn(repoId: RepoId, sessionKey: SessionKey): void {
    const record = runs.records(repoId).find((r) => r.sessionKey === sessionKey)
    if (record !== undefined) handoff.resumedTurn(repoId, { ...record, sessionKey })
  }
  function holdsSessionRequired(repoId: RepoId): boolean {
    return stateFor(repoId).owner !== 'app'
  }
  function dismissDenial(repoId: RepoId, id: string): void {
    void runs.dismissDenial(repoId, id).then(() => ctx.live.watcher.republish())
  }
  function clearDenialsFor(repoId: RepoId, rule: string): void {
    void runs.clearRule(repoId, rule).then(() => ctx.live.watcher.republish())
  }

  /** Ends the runs whose sessions are gone and records an operator joining one, so the loop reads what the hosted sessions say. */
  async function syncRuns(repoId: RepoId): Promise<void> {
    for (const { runId, change } of syncChanges(runs.records(repoId), (sessionKey) => ctx.live.hostedStore.snapshotOf(sessionKey))) {
      if (change.kind === 'joined') await runs.joined(repoId, runId, change.at)
      else if (change.kind === 'ended') await runs.ended(repoId, runId, null)
    }
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
      const runState = ctx.stores.runStates.current(entry.id).state
      const ownershipParams = { repoRoot: entry.path, repo: entry.config.repo }
      let ownership = await readOwnership(ctx, ownershipParams)

      // A persisted run/draining state with an absent record means the app restarted; it takes
      // ownership back rather than sitting idle until the operator clicks Run again.
      if (ownership.kind === 'absent' && (runState === RUN_TARGET.run || runState === RUN_TARGET.drain)) {
        const taken = await takeOwnership(ctx, ownershipParams)
        if (taken.ok) ownership = await readOwnership(ctx, ownershipParams)
      }

      const owner = ownerOf(ownership)
      const state = stateFor(entry.id)
      state.ownedSince = ownership.kind === 'app' ? ownership.since : null
      state.unreadableMessage = ownership.kind === 'unreadable' ? ownership.message : null
      await syncRuns(entry.id)
      const records = recordsOf(entry.id)

      const anyLive = records.some((r) => r.state === 'started')
      if (entry.config.commands.budget !== null && (owner === 'app' || anyLive)) {
        if (!state.budgetReset) {
          const resetResult = await budgetReset(ctx, entry)
          if (resetResult.ok) {
            state.budgetReset = true
          } else if (owner === 'app') {
            report(entry.id, owner, { kind: 'budget-unavailable', message: resetResult.message }, runState)
            return
          }
        }
        if (state.budgetReset) {
          const sets = budgetLiveSets(records)
          const sweepResult = await budgetSweep(ctx, entry, sets)
          state.budget = { line: sweepResult.line, problem: sweepResult.problem, notes: state.budget?.notes ?? [], costUsd: sumCostUsd(records) }
        }
      }

      if (owner !== 'app') {
        report(entry.id, owner, { kind: 'idle' }, runState)
        return
      }

      handoff.remember(entry)
      // A hand-back the last boot found finished but unwritten settles once, from the run alone.
      if (!state.replayed) {
        state.replayed = true
        for (const unsettled of runs.unsettled(entry.id)) handoff.settle(entry.id, unsettled.record, unsettled.outcome, null)
      }
      await handoff.retryPending(entry.id)

      if (tick === undefined || tick.blind !== null || viewer === null) {
        report(entry.id, owner, activeOrIdle(records), runState)
        return
      }

      // The observation pass is independent of whatever dispatches below.
      const observable = observableFrom(tick, runState)
      if (observable.length > 0) {
        const repoState = snapshotRepoState(entry.id)
        if (repoState !== undefined) await runObservationPass(ctx, entry, observable, repoState, state)
      }

      const dispatchable = dispatchableFrom(tick, runState)
      const liveNumbers = new Set(records.filter((r) => r.state === 'started').map((r) => r.number))
      const notAlreadyLive = dispatchable.filter((c) => !liveNumbers.has(c.number))
      const candidates = selectDispatches({ dispatchable: notAlreadyLive, recent: records, now: ctx.clock.now() })
      if (candidates.length === 0) {
        report(entry.id, owner, activeOrIdle(records), runState)
        return
      }

      const reread = await ctx.tracker.readItemsByNumber({ repo: { owner: entry.config.owner, name: entry.config.name }, numbers: candidates.map((c) => c.number) })
      if (!reread.ok) return // a failed re-read dispatches nothing this pass

      const resolvedByNumber = new Map(reread.resolved.map((r) => [r.number, r] as const))
      const survivors = candidates.filter((c) => {
        const resolved = resolvedByNumber.get(c.number)
        return resolved !== undefined && !reread.unavailable.includes(c.number) && survived(resolved, c, viewer, ctx.stores.pipelineState.ticket(entry.id, { kind: c.kind, number: c.number }))
      })
      if (survivors.length === 0) {
        report(entry.id, owner, activeOrIdle(records), runState)
        return
      }

      const pass = { entry, survivors, resolvedByNumber, state, owner, runState, viewer, items: snapshotRepoState(entry.id)?.items ?? [] }
      const gated = entry.config.commands.budget !== null ? await budgetGated(ctx, pass) : survivors
      if (gated.length === 0) {
        report(entry.id, owner, activeOrIdle(recordsOf(entry.id)), runState)
        return
      }
      const waiting = await serialize(() => launchGated(ctx, pass, gated, () => stopped))
      const limit = (await ctx.live.hostedStore.capacity()).limit
      report(entry.id, owner, waiting > 0 ? { kind: 'at-capacity', limit, waiting } : activeOrIdle(recordsOf(entry.id)), runState)
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

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    if (stopped) return
    lastSnapshot = snapshot
    const list = await ctx.repos.list()
    if (!list.ok) return
    await Promise.all(list.repositories.filter(isReadyEntry).map((entry) => considerRepo(entry)))
  }

  function status(): readonly RepoDispatchStatus[] {
    return statusOf(repoStates, (repoId) => runs.denials(repoId), (repoId) => runs.list(repoId))
  }
  function liveStages(repoId: RepoId): readonly string[] {
    return liveStagesOf(runs.records(repoId))
  }
  function stageLiveness(repoId: RepoId): { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null {
    return stageLivenessOf(stateFor(repoId), runs.records(repoId), handoff.pendingNumbers(repoId), runs.list(repoId), ctx.clock.now())
  }
  function endedStages(repoId: RepoId): readonly EndedStage[] {
    return endedStagesOf(runs.records(repoId), (sessionKey) => handoff.resultFor(sessionKey))
  }
  function liveStageSessions() {
    return liveStageSessionsOf([...repoStates.keys()], (repoId) => runs.records(repoId), (repoId) => repoNames.get(repoId) ?? String(repoId))
  }
  async function stopFor(repoId: RepoId, number: number): Promise<boolean> {
    const record = runs.records(repoId).find((r) => r.number === number && r.state === 'started' && r.sessionKey !== null)
    if (record === undefined || record.sessionKey === null) return false
    const result = await ctx.live.hostedStore.close(record.sessionKey)
    if (result.ok) ctx.live.watcher.republish()
    return result.ok
  }

  async function standDown(repoId: RepoId): Promise<boolean> {
    const live = runs.records(repoId).filter((r): r is StageRecord & { sessionKey: SessionKey } => r.state === 'started' && r.sessionKey !== null)
    if (live.length === 0) return false
    let allOk = true
    for (const record of live) {
      const result = await ctx.live.hostedStore.close(record.sessionKey)
      if (!result.ok) allOk = false
    }
    ctx.live.watcher.republish()
    return allOk
  }

  function shutdown(): void {
    stopped = true
  }

  return { consider, status, stopFor, standDown, liveStages, stageLiveness, endedStages, liveStageSessions, shutdown, recordOutcome, recordResumedTurn, holdsSessionRequired, dismissDenial, clearDenialsFor }
}

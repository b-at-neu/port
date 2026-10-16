import type { StageRecord, OwnershipRead, StageSessionSummary } from '@/types/dispatch'

// The app's own dispatch loop: turns a BoardSnapshot into real stage-session launches through a
// StageLauncher seam. `consider` is the one entry point main/ipc.ts wires to `onTick`.
import type { BoardSnapshot } from '@/types/board'
import type { BudgetNote, BudgetStatus, DispatchOwner, DispatcherState, ObservationRecord, RepoDispatchStatus } from '@/types/dispatch'
import { RUN_TARGET } from '@/types/dispatch'
import type { RunState } from '@/types/dispatch'
import type { RepoId } from '@/utils/repos'

import type { SessionKey } from '@/types/hosting'
import type { ReadyEntry } from '@/types/actions'

import { dispatchableFrom, observableFrom } from '@/main/tick/dispatchable'



import { labelName } from '@/utils/labels/vocabulary'
import { runObservationPass } from '@/main/dispatch/observe-pass'
import { commentFailureMessage, selectDispatches, survived } from '@/main/dispatch/select'
import { budgetLiveSets, budgetRoute, escalationBody, sumCostUsd } from '@/main/dispatch/budget'
import type { StageDenial } from '@/types/stage'
import { withDenial, withoutDenialId, withoutDenialRule } from '@/main/dispatch/attention'

import { boundRecords, endedStagesOf, freeSlots, refreshRecords } from '@/main/dispatch/launch'


import type { EndedStage, TickActionable, TickReport } from '@/types/tick'
import type { StageOutcome } from '@/types/stage-session'
import type { Dispatcher, CreateDispatcherParams } from '@/types/dispatch'

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
  denials: StageDenial[]
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
    denials: [],
  }
}

function newStageRecord(candidate: TickActionable, state: 'started' | 'failed', at: string, sessionKey: SessionKey | null, detail: string | null): StageRecord {
  return { sessionKey, agent: candidate.agent, number: candidate.number, kind: candidate.kind, trigger: candidate.trigger, state, at, detail, outcome: null, claudeSessionId: null, operatorJoinedAt: null }
}

function ownerOf(ownership: OwnershipRead): DispatchOwner {
  return ownership.kind === 'absent' ? 'none' : ownership.kind
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
      ? { kind: 'active', recent: records.map((r) => ({ agent: r.agent, number: r.number, kind: r.kind, state: r.state, at: r.at, detail: r.detail, outcome: r.outcome, sessionKey: r.sessionKey, claudeSessionId: r.claudeSessionId, operatorJoinedAt: r.operatorJoinedAt })) }
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
  function recordDenial(repoId: RepoId, denial: StageDenial): void {
    stateFor(repoId).denials = [...withDenial(stateFor(repoId).denials, denial)]
    deps.onChange()
  }
  function dismissDenial(repoId: RepoId, id: string): void {
    const state = repoStates.get(repoId)
    if (state !== undefined) state.denials = [...withoutDenialId(state.denials, id)]
    deps.onChange()
  }
  function clearDenialsFor(repoId: RepoId, rule: string): void {
    const state = repoStates.get(repoId)
    if (state !== undefined) state.denials = [...withoutDenialRule(state.denials, rule)]
    deps.onChange()
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
          state.budget = { line: sweepResult.line, problem: sweepResult.problem, notes: state.budget?.notes ?? [], costUsd: sumCostUsd(state.records) }
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
      state.budget = { line: state.budget?.line ?? null, problem: state.budget?.problem ?? null, costUsd: state.budget?.costUsd ?? null, notes: notes.length > NOTE_LIMIT ? notes.slice(notes.length - NOTE_LIMIT) : notes }
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
            pushRecord(entry.id, newStageRecord(candidate, 'started', at, result.sessionKey, null))
            deps.ledger.record(entry.id, candidate.number)
            deps.forceDispatch.clear(entry.id, candidate.number)
          } else if (result.kind === 'at-capacity') {
            waiting += 1
          } else {
            pushRecord(entry.id, newStageRecord(candidate, 'failed', at, null, result.message))
          }
        } catch (error) {
          const at = deps.now().toISOString()
          const message = error instanceof Error ? error.message : String(error)
          pushRecord(entry.id, newStageRecord(candidate, 'failed', at, null, message))
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
      denials: s.denials,
      interrupted: deps.interrupted?.(repoId) ?? [],
    }))
  }

  function liveStages(repoId: RepoId): readonly string[] {
    const state = repoStates.get(repoId)
    if (state === undefined) return []
    return state.records.filter((r) => r.state === 'started').map((r) => `${r.agent} #${String(r.number)}`)
  }
  function stageLiveness(repoId: RepoId): { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null {
    if (stateFor(repoId).owner !== 'app') return null
    return { live: liveStages(repoId), interrupted: (deps.interrupted?.(repoId) ?? []).map((i) => `${i.agent} #${String(i.number)}`) }
  }
  function endedStages(repoId: RepoId): readonly EndedStage[] {
    return endedStagesOf(repoStates.get(repoId)?.records ?? [])
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

  return { consider, status, stopFor, standDown, liveStages, stageLiveness, endedStages, liveStageSessions, shutdown, recordOutcome, holdsSessionRequired, recordDenial, dismissDenial, clearDenialsFor }
}

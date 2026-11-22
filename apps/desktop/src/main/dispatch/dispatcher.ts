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
import { KIND_PROMPT_NAMES, STAGE_PROMPT_NAMES } from '@/utils/stage/prompt'
import { ticketIndex, ticketLabelFor } from '@/utils/tickets/ticket'
import { runObservationPass } from '@/main/dispatch/observe-pass'
import { selectDispatches, survived } from '@/main/dispatch/select'
import { budgetLiveSets, budgetRoute, escalateOverBudget, sumCostUsd } from '@/main/dispatch/budget'
import { createStageHandoff } from '@/main/dispatch/handoff'
import type { StageDenial } from '@/types/stage'
import { boundRecords, endedStagesOf, freeSlots, newStageRecord, refreshRecords, settlingDescriptions, targetOf } from '@/main/dispatch/launch'
import type { ResolvedItem } from '@/types/github'
import type { EndedStage, TickActionable } from '@/types/tick'
import type { InterruptedStage } from '@/types/stage'
import type { StagePlanFile } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import { reviewDispatchFacts } from '../../../../../scripts/port-tick/gates'
import type { ReviewDispatchFacts } from '../../../../../scripts/port-tick/gates'
import type { Dispatcher, CreateDispatcherParams, StageLaunchFailureCause, StageSnapshot } from '@/types/dispatch'
import { draftOf, endedIntents, launchFailedIntent, noRelated } from '@/main/incidents/raise'
import type { IncidentIntent, IncidentOutcome } from '@/types/incidents'

const RECENT_LIMIT = 20
const NOTE_LIMIT = 20

/** The text the stage session's first message opens with; port has already moved the label, so no agent step names one. */
export const DISPATCH_PROMPT = '<Stage> stage for <kind> #<n>. Run your pipeline stage for #<n>. port has already moved its label. Follow your Pre-flight, Work, and Handoff steps exactly.'
export const REFRESH_PROMPT = 'Refresh stage for pull request #<n>. Run your pipeline stage for pull request #<n> in refresh mode.'

/** `launch.ts`'s own `StageLaunchRequest.prompt` is filled from this, never re-derived at the launcher. */
export function promptFor(actionable: Pick<TickActionable, 'trigger' | 'number' | 'agent' | 'kind'>): string {
  const n = String(actionable.number)
  if (actionable.trigger === 'refreshBranch') return REFRESH_PROMPT.replaceAll('<n>', n)
  return DISPATCH_PROMPT.replaceAll('<Stage>', STAGE_PROMPT_NAMES[actionable.agent]).replaceAll('<kind>', KIND_PROMPT_NAMES[actionable.kind]).replaceAll('<n>', n)
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
  return ownership.kind === 'absent' ? 'none' : ownership.kind
}

export function createDispatcher(deps: CreateDispatcherParams): Dispatcher {
  const repoStates = new Map<RepoId, RepoDispatcherState>()
  const repoNames = new Map<RepoId, string>()
  const inFlight = new Set<RepoId>()
  const pending = new Map<RepoId, ReadyEntry>()
  let stopped = false
  // Serializes every repository's own launch section so two repositories never race for the same free slot.
  let launchQueue: Promise<void> = Promise.resolve()
  const handoff = createStageHandoff({ write: (p) => deps.stageLabels.transition({ ...p, snapshot: snapshotOf(p.entry.id, p.record.number) }), auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch, onChange: deps.onChange, recordIncident: deps.recordIncident, requestRead: deps.requestRead, now: deps.now })

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
      ? { kind: 'active', recent: records.map((r) => ({ agent: r.agent, number: r.number, kind: r.kind, trigger: r.trigger, state: r.state, at: r.at, detail: r.detail, outcome: r.outcome, sessionKey: r.sessionKey, claudeSessionId: r.claudeSessionId, operatorJoinedAt: r.operatorJoinedAt })) }
      : { kind: 'idle' }
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
        return resolved !== undefined && !reread.unavailable.includes(c.number) && survived(resolved, c, entry.config.vocabulary, viewer, deps.stateLabels?.(entry.id, c.kind, c.number, entry.config.vocabulary) ?? null)
      })
      if (survivors.length === 0) {
        report(entry.id, owner, activeOrIdle(entry.id), runState)
        return
      }

      await launchSurvivors(entry, survivors, resolvedByNumber, state, owner, runState, viewer)
    } finally {
      inFlight.delete(entry.id)
    }
  }

  async function launchSurvivors(entry: ReadyEntry, survivors: readonly TickActionable[], resolvedByNumber: ReadonlyMap<number, ResolvedItem>, state: RepoDispatcherState, owner: DispatchOwner, runState: RunState, viewer: string): Promise<void> {
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
        const item = candidate.kind === 'pull-request' ? snapshotRepoState(entry.id)?.items.find((i) => i.number === candidate.number) : undefined
        await escalateOverBudget({ entry, candidate, line: result.line, notes, viewer, item, escalate: deps.escalate, dirs: deps.dirs })
      }
      gated = kept
      state.budget = { line: state.budget?.line ?? null, problem: state.budget?.problem ?? null, costUsd: state.budget?.costUsd ?? null, notes: notes.length > NOTE_LIMIT ? notes.slice(notes.length - NOTE_LIMIT) : notes }
    }

    if (gated.length === 0) {
      report(entry.id, owner, activeOrIdle(entry.id), runState)
      return
    }

    const index = ticketIndex(snapshotRepoState(entry.id)?.items ?? [])
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
        let review: ReviewDispatchFacts | null = null
        if (candidate.agent === 'review') {
          if (candidate.cycle === null) {
            const message = `Couldn't count the earlier reviews on pull request #${candidate.number}, so the review wasn't started.`
            pushRecord(entry.id, newStageRecord(candidate, 'failed', deps.now().toISOString(), null, message))
            continue
          }
          review = reviewDispatchFacts({ priorReviews: candidate.cycle.count, author: resolvedByNumber.get(candidate.number)?.author ?? null, viewer })
        }
        const claimed = await claim(entry, candidate, resolvedByNumber.get(candidate.number))
        if (!claimed) continue
        try {
          const result = await launch.launch({
            entry,
            agent: candidate.agent,
            number: candidate.number,
            kind: candidate.kind,
            trigger: candidate.trigger,
            model: entry.config.models[candidate.agent],
            prompt: promptFor(candidate),
            title: ticketLabelFor(index, candidate.number, candidate.kind),
            target: targetOf(candidate.kind, resolvedByNumber.get(candidate.number)),
            review,
          })
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
            await rollback(entry, candidate)
            waiting += 1
          } else {
            await launchFailed(entry, candidate, result.cause, result.message, true)
          }
        } catch (error) {
          await launchFailed(entry, candidate, 'threw', error instanceof Error ? error.message : String(error), true)
        }
      }
    })

    const limit = (await deps.store.capacity()).limit
    if (waiting > 0) report(entry.id, owner, { kind: 'at-capacity', limit, waiting }, runState)
    else report(entry.id, owner, activeOrIdle(entry.id), runState)
  }

  /** Trigger → in-flight before the session exists. `moved` skips silently, since the next read shows the truth; any other refusal is a launch failure. */
  async function claim(entry: ReadyEntry, candidate: TickActionable, resolved: ResolvedItem | undefined): Promise<boolean> {
    if (resolved === undefined) return false
    const result = await deps.stageLabels.claim({ entry, candidate, resolved, auditDir: deps.dirs.audit })
    if (result.kind === 'applied') return true
    if (result.reason !== 'moved') await launchFailed(entry, candidate, `claim-${result.reason}`, `port couldn't move the label before starting: ${result.reason}${result.detail === null ? '' : ` (${result.detail})`}`, false)
    return false
  }

  /** A launch that never produced a session: undoes the claim when it made one, records the failure and raises its incident. */
  async function launchFailed(entry: ReadyEntry, candidate: TickActionable, cause: StageLaunchFailureCause | `claim-${string}`, message: string, undo: boolean): Promise<void> {
    if (undo) await rollback(entry, candidate)
    pushRecord(entry.id, newStageRecord(candidate, 'failed', deps.now().toISOString(), null, message))
    raise(entry.id, candidate, launchFailedIntent(candidate, cause), { kind: 'failed' })
  }

  function raise(repoId: RepoId, ref: Pick<StageRecord, 'number' | 'kind'>, intent: IncidentIntent, outcome: IncidentOutcome): void {
    const repo = repoNames.get(repoId)
    if (repo !== undefined) void deps.recordIncident(draftOf(intent, { repo, kind: ref.kind, number: ref.number }, outcome, noRelated())).catch(() => undefined)
  }

  /** Undoes a claim whose launch failed; a refused rollback is left to the stall ladder. */
  async function rollback(entry: ReadyEntry, candidate: TickActionable): Promise<void> {
    await deps.stageLabels.transition({ entry, record: candidate, event: { kind: 'rollback' }, auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch })
  }

  // The most recent consider() call's own snapshot, the one a pass reads when it starts.
  let lastSnapshot: BoardSnapshot | null = null
  function snapshotRepoState(repoId: RepoId): Extract<BoardSnapshot['state']['repositories'][number], { readonly ok: true }> | undefined {
    const found = lastSnapshot?.state.repositories.find((r) => r.ok && r.repoId === repoId)
    return found?.ok ? found : undefined
  }
  function snapshotOf(repoId: RepoId, number: number): StageSnapshot {
    const repoState = snapshotRepoState(repoId)
    return { item: repoState?.items.find((i) => i.number === number) ?? null, at: repoState !== undefined && 'at' in repoState.freshness.github ? repoState.freshness.github.at : null }
  }

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    if (stopped) return
    lastSnapshot = snapshot
    const list = await deps.listRepositories(deps.registryDeps)
    if (!list.ok) return
    const readyEntries = list.repositories.filter((entry): entry is ReadyEntry => 'config' in entry)
    await Promise.all(readyEntries.map((entry) => considerRepo(entry)))
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
      denials: deps.denials.list(repoId),
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
    const settling = settlingDescriptions(repoStates.get(repoId)?.records ?? [], handoff.pendingNumbers(repoId), deps.now())
    return { live: [...liveStages(repoId), ...settling], interrupted: (deps.interrupted?.(repoId) ?? []).map((i) => `${i.agent} #${String(i.number)}`) }
  }
  function endedStages(repoId: RepoId): readonly EndedStage[] {
    return endedStagesOf(repoStates.get(repoId)?.records ?? [], (sessionKey) => handoff.resultFor(sessionKey))
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

  return { consider, status, stopFor, standDown, liveStages, stageLiveness, endedStages, liveStageSessions, shutdown, recordOutcome, recordResumedTurn, trackResumed, holdsSessionRequired, recordDenial, dismissDenial, clearDenialsFor }
}

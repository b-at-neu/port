// #265: the app's own dispatcher — the composition root that turns a
// `BoardSnapshot` into real `Agent()` calls, the same way the cockpit's own
// tick does, through a hosted dispatcher session rather than a Claude Code
// session of its own. `consider` is the one entry point `main/ipc.ts` wires
// to `onSnapshot`; `status`/`relay`/`stopFor` serve the renderer's own
// reads and writes.
import type { BoardSnapshot } from '../../shared/board/types'
import type { BudgetNote, BudgetStatus, DispatchOwner, DispatchRecord, DispatchRelayResult, DispatcherState, ObservationRecord, RepoDispatchStatus } from '../../shared/dispatch/types'
import type { DrainState } from '../../shared/dispatch/types'
import type { RepoId } from '../../shared/repos'
import type { AgentSummary, HostedSessionSnapshot, HostedStore, SessionKey } from '../hosting'
import type { ReadyEntry } from '../actions'
import type { ApplyObservationParams, ApplyObservationResult, EscalateToHumanParams, EscalateToHumanResult } from '../actions'
import type { RegistryDeps } from '../registry'
import type { ReposListResponse } from '../../shared/ipc'
import type { DispatchLedger, RefreshMemo } from '../tick'
import { dispatchableFrom, observableFrom } from '../tick'
import type { ReadGateClaimParams } from '../writes'
import type { ClaimRead } from '../writes'
import type { FetchItemsByNumberParams } from '../github'
import type { ItemsByNumberFetch, ResolvedItem } from '../../shared/github/types'
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepositoryState } from '../../shared/state/types'
import type { WriteOutcome } from '../../shared/writes/types'
import type { TickActionable, TickReport } from '../../shared/tick/types'
import { runObservationPass } from './observe-pass'
import { confirmStarted, markUnconfirmed, selectDispatches } from './select'
import { budgetLiveSets, budgetRoute, escalationBody } from './budget'
import type { BudgetGate } from './budget-gate'
import { composeDispatchTurn, composeRelayTurn, DISPATCHER_INSTRUCTIONS, DISPATCHER_MODEL, missingAgentOf, specFor } from './turn'
import type { DispatchSpec } from './turn'

const RECENT_LIMIT = 20
const NOTE_LIMIT = 20

export interface CreateDispatcherParams {
  readonly store: HostedStore
  readonly ledger: DispatchLedger
  /** The app-wide drain switch's own `current()` — read fresh every pass,
   *  never cached, the same rule the claim read below follows. */
  readonly drain: () => DrainState
  readonly readGateClaim: (params: ReadGateClaimParams) => Promise<ClaimRead>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly listRepositories: (registryDeps: RegistryDeps) => Promise<ReposListResponse>
  readonly registryDeps: RegistryDeps
  /** #293: runs `commands.budget`'s reset/sweep/dispatch modes and
   *  classifies the result — `budget-gate.ts`'s own composition. */
  readonly budget: BudgetGate
  readonly escalate: (params: EscalateToHumanParams) => Promise<EscalateToHumanResult>
  /** #292: writes one machine observation — defaults to
   *  `main/actions/observe.ts`'s `applyObservation` (`runtime.ts`'s own
   *  composition), injectable the same way `escalate` already is. */
  readonly writeObservation: (params: ApplyObservationParams) => Promise<ApplyObservationResult>
  /** #292: the app's own process-scoped refresh memo
   *  (`main/tick/ledger.ts`'s `createRefreshMemo`) — the *same* instance
   *  `main/state/watcher.ts`'s own `planTick` calls read and write, never a
   *  second one that would disagree with what the tick just reported. */
  readonly refreshMemo: RefreshMemo
  readonly dirs: { readonly audit: string; readonly scratch: string }
  readonly onChange: () => void
  readonly now: () => Date
}

export interface Dispatcher {
  /** Called once per `BoardSnapshot` (`main/ipc.ts`'s own
   *  `onSnapshot`) — considers every ready repository, at most one pass
   *  each at a time. Never throws: a failure in one repository's pass is
   *  reported on its own status, never allowed to stop the others. */
  consider(snapshot: BoardSnapshot): Promise<void>
  status(): readonly RepoDispatchStatus[]
  relay(params: { readonly repoId: RepoId; readonly agentId: string; readonly text: string }): Promise<DispatchRelayResult>
  /** The halt composition's own per-item stop (`dispatch/halt.ts`'s
   *  `HaltDispatchDeps.stopFor`) — `true` only when this dispatcher found a
   *  `started` task for `(repoId, number)` and the SDK call itself did not
   *  throw. */
  stopFor(repoId: RepoId, number: number): Promise<boolean>
  /** #292: this repository's own live dispatcher session's `tasks` with
   *  `status: 'started'`, as descriptions (`"<stage> #<n>"`) — `[]` when no
   *  dispatcher session is live. `main/state/watcher.ts` passes this into
   *  `planTick`'s own `startedTasks` param, so a reset never fires against an
   *  agent this app itself just started, even before the session scan has
   *  caught up to it. */
  startedTasks(repoId: RepoId): readonly string[]
}

interface RepoDispatcherState {
  sessionKey: SessionKey | null
  recent: DispatchRecord[]
  owner: DispatchOwner
  dispatcherState: DispatcherState
  draining: boolean
  claimedAt: string | null
  /** #293: `reset` runs at most once per process per repository — set once
   *  the attempt actually succeeds, never before, so a failing script keeps
   *  retrying on every pass rather than wedging the gate shut forever. */
  budgetReset: boolean
  /** #293: consecutive `hold` verdicts per candidate number, process-scoped
   *  like `main/tick/ledger.ts`'s own `createUnknownStreaks` — a restart
   *  starts every item back at 0, never a false second-strike dispatch. */
  budgetHolds: Map<number, number>
  budget: BudgetStatus | null
  /** #292: every observation write this process has attempted, newest last,
   *  bounded to `OBSERVED_LIMIT`. */
  observed: ObservationRecord[]
  /** #292: the instant (this process's own clock) each item number's most
   *  recent observation write attempt happened — the stale-read guard reads
   *  this against the repository's current GitHub `fetchedAt`, so an item
   *  this process already wrote is skipped until a fresher read has caught
   *  up to it, never decided again from a read that predates the write. */
  observedWriteAt: Map<number, string>
}

function emptyRepoState(): RepoDispatcherState {
  return {
    sessionKey: null,
    recent: [],
    owner: 'cockpit',
    dispatcherState: { kind: 'idle' },
    draining: false,
    claimedAt: null,
    budgetReset: false,
    budgetHolds: new Map(),
    budget: null,
    observed: [],
    observedWriteAt: new Map(),
  }
}

function ownerOf(claim: ClaimRead): DispatchOwner {
  if (claim.state === 'unreadable') return 'nobody'
  if (claim.state === 'held' && claim.scopes.includes('dispatch')) return 'app'
  return 'cockpit'
}

/** The re-read survivor test (PIPELINE.md → "The dispatcher" step 5): the
 *  trigger's own resolved name is still present, no other role-bearing
 *  label (anything but a marker) is present alongside it, and the viewer is
 *  still among the assignees. Anything else is "moved" — dropped, never
 *  dispatched this pass. */
function survived(resolved: ResolvedItem, candidate: TickActionable, vocabulary: LabelVocabulary, viewer: string): boolean {
  const triggerLabel = vocabulary.labels.find((l) => l.key === candidate.trigger)
  if (triggerLabel === undefined || !resolved.labels.includes(triggerLabel.name)) return false
  const roleBearingNames = new Set(vocabulary.labels.filter((l) => l.role !== 'marker').map((l) => l.name))
  const others = resolved.labels.filter((name) => name !== triggerLabel.name && roleBearingNames.has(name))
  // #292: a `refreshBranch` candidate tolerates exactly one co-present
  // role-bearing label — the sanctioned pair `main/tick/plan.ts`'s own
  // `actionableAndHeld` already allows (a refresh trigger sitting beside
  // another trigger it does not strand). Every other trigger keeps the
  // original single-label rule.
  const tolerance = candidate.trigger === 'refreshBranch' ? 1 : 0
  if (others.length > tolerance) return false
  return resolved.assignees.includes(viewer)
}

/** #293: `null` for a comment that was never attempted or that itself
 *  applied — a short description otherwise, for the 'escalated' note's own
 *  "comment explaining why didn't post (<message>)" clause. */
function commentFailureMessage(comment: WriteOutcome | null): string | null {
  if (comment === null || comment.kind === 'applied') return null
  return comment.kind === 'write-failed' ? comment.stderr : comment.kind
}

export function createDispatcher(deps: CreateDispatcherParams): Dispatcher {
  const repoStates = new Map<RepoId, RepoDispatcherState>()
  const inFlight = new Set<RepoId>()

  function stateFor(repoId: RepoId): RepoDispatcherState {
    const existing = repoStates.get(repoId)
    if (existing !== undefined) return existing
    const created = emptyRepoState()
    repoStates.set(repoId, created)
    return created
  }

  function pushRecent(repoId: RepoId, recent: readonly DispatchRecord[]): void {
    const state = stateFor(repoId)
    state.recent = recent.length > RECENT_LIMIT ? recent.slice(recent.length - RECENT_LIMIT) : [...recent]
  }

  function report(repoId: RepoId, owner: DispatchOwner, dispatcherState: DispatcherState, draining: boolean): void {
    const state = stateFor(repoId)
    state.owner = owner
    state.dispatcherState = dispatcherState
    state.draining = draining
    deps.onChange()
  }

  async function ensureSession(entry: ReadyEntry, repoId: RepoId, draining: boolean): Promise<HostedSessionSnapshot | null> {
    const state = stateFor(repoId)
    if (state.sessionKey !== null) {
      const existing = deps.store.snapshotOf(state.sessionKey)
      if (existing !== null && existing.phase !== 'ended') return existing
    }
    const started = await deps.store.start({
      repoId,
      mode: { kind: 'fresh' },
      cwd: entry.path,
      role: { kind: 'dispatcher', model: DISPATCHER_MODEL, instructions: DISPATCHER_INSTRUCTIONS, title: `Port dispatcher · ${entry.config.repo}` },
    })
    if (!started.ok) {
      report(repoId, 'app', started.kind === 'at-capacity' ? { kind: 'dispatcher-failed', reason: 'at-capacity', limit: started.limit } : { kind: 'dispatcher-failed', reason: 'runtime' }, draining)
      return null
    }
    state.sessionKey = started.snapshot.sessionKey
    return started.snapshot
  }

  /** `agents` off the live snapshot's own capabilities — `[]` while still
   *  `pending`, since nothing may be dispatched before the session's own
   *  report of what it can address. */
  function agentsOf(snapshot: HostedSessionSnapshot): readonly AgentSummary[] {
    return snapshot.capabilities.kind === 'ready' ? snapshot.capabilities.agents : []
  }

  async function considerRepo(entry: ReadyEntry, tick: TickReport | undefined, viewer: string | null, repository: Extract<RepositoryState, { readonly ok: true }> | undefined): Promise<void> {
    if (inFlight.has(entry.id)) return
    inFlight.add(entry.id)
    try {
      const claim = await deps.readGateClaim({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      const owner = ownerOf(claim)
      const draining = deps.drain().gate !== 'open'
      stateFor(entry.id).claimedAt = claim.state === 'held' ? claim.claimedAt : null

      const state = stateFor(entry.id)

      // Confirm any already-sent records against the live session's own
      // task view, before computing new candidates — the floor (below)
      // reads each record's own `at`, regardless of state. #293: moved
      // ahead of the owner early-return below — the budget sweep's live set
      // must stay current even after the claim is released while this
      // app's own agents are still working through their tasks.
      let snap: HostedSessionSnapshot | null = null
      if (state.sessionKey !== null) {
        snap = deps.store.snapshotOf(state.sessionKey)
        if (snap !== null) {
          const { updated, newlyStarted } = confirmStarted(state.recent, snap.tasks)
          let next = updated
          for (const r of newlyStarted) deps.ledger.record(entry.id, r.number)
          // The turn that sent it has itself finished (back to 'ready')
          // with nothing matching — never left at 'sent' forever.
          if (snap.phase === 'ready') next = markUnconfirmed(next)
          pushRecent(entry.id, next)
        }
      }

      // #293: budget bookkeeping — runs whenever a ceiling is configured and
      // either this app currently owns dispatch, or it once started a
      // session here and that session's agents may still be live. `reset`
      // runs at most once per process per repository; `sweep` runs on every
      // pass so the ledger comment and the owner line stay current even
      // while nothing is being dispatched.
      if (entry.config.commands.budget !== null && (owner === 'app' || state.sessionKey !== null)) {
        if (!state.budgetReset) {
          const resetResult = await deps.budget.reset(entry)
          if (resetResult.ok) {
            state.budgetReset = true
          } else if (owner === 'app') {
            // This fails closed: a gate that can't run dispatches nothing.
            report(entry.id, owner, { kind: 'budget-unavailable', message: resetResult.message }, draining)
            return
          }
        }
        if (state.budgetReset) {
          const sets = budgetLiveSets(snap?.tasks ?? [], state.recent)
          const sweepResult = await deps.budget.sweep(entry, sets)
          state.budget = { line: sweepResult.line, problem: sweepResult.problem, notes: state.budget?.notes ?? [] }
        }
      }

      if (owner !== 'app') {
        report(entry.id, owner, { kind: 'idle' }, draining)
        return
      }

      if (tick === undefined || tick.blind !== null || viewer === null) {
        const recent = stateFor(entry.id).recent
        report(entry.id, owner, recent.length > 0 ? { kind: 'active', recent } : { kind: 'idle' }, draining)
        return
      }

      // #292: the observation pass — independent of whatever dispatches
      // below, so it still runs on a repository with nothing else to
      // dispatch this pass.
      if (repository !== undefined) {
        const observable = observableFrom(tick, deps.drain())
        if (observable.length > 0) {
          await runObservationPass(entry, observable, repository, state, {
            writeObservation: deps.writeObservation,
            refreshMemo: deps.refreshMemo,
            dirs: deps.dirs,
            now: deps.now,
            onChange: deps.onChange,
          })
        }
      }

      const dispatchable = dispatchableFrom(tick, deps.drain())
      const candidates = selectDispatches({ dispatchable, recent: stateFor(entry.id).recent, now: deps.now() })
      if (candidates.length === 0) {
        const recent = stateFor(entry.id).recent
        report(entry.id, owner, recent.length > 0 ? { kind: 'active', recent } : { kind: 'idle' }, draining)
        return
      }

      const snapshot = await ensureSession(entry, entry.id, draining)
      if (snapshot === null) return // ensureSession already reported dispatcher-failed
      if (snapshot.capabilities.kind === 'pending') return // next pass re-checks, never a busy-wait here
      if (snapshot.capabilities.kind === 'unavailable') {
        report(entry.id, owner, { kind: 'dispatcher-failed', reason: 'runtime' }, draining)
        return
      }
      const plugin = snapshot.capabilities.plugin
      if (plugin.kind === 'missing' || plugin.kind === 'shadowed' || plugin.kind === 'duplicate') {
        report(entry.id, owner, { kind: 'dispatcher-failed', reason: 'plugin' }, draining)
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
        const recent = stateFor(entry.id).recent
        report(entry.id, owner, recent.length > 0 ? { kind: 'active', recent } : { kind: 'idle' }, draining)
        return
      }

      const agents = agentsOf(snapshot)
      const missing = missingAgentOf(survivors, agents)
      const specs = survivors.map((c) => specFor(c, entry.config.models, agents)).filter((s) => s !== null)

      if (specs.length === 0) {
        report(entry.id, owner, missing !== null ? { kind: 'agents-missing', agent: missing } : { kind: 'idle' }, draining)
        return
      }

      const resolvableNumbers = new Set(specs.map((s) => s.name))
      let gatedSpecs: readonly DispatchSpec[] = specs
      let sentCandidates: readonly TickActionable[] = survivors.filter((c) => resolvableNumbers.has(`${c.agent}-${String(c.number)}`))

      // #293: the budget gate — the last pre-dispatch veto, only when a
      // ceiling is configured, run once every other veto above has already
      // filtered `survivors`/`specs` down. An `allow` starts a row's clock,
      // so anything evaluated after this would charge a whole sweep
      // interval to a ticket that never dispatched.
      if (entry.config.commands.budget !== null) {
        const specByName = new Map(specs.map((s) => [s.name, s] as const))
        const keptSpecs: DispatchSpec[] = []
        const keptCandidates: TickActionable[] = []
        const notes: BudgetNote[] = []

        for (const candidate of sentCandidates) {
          const spec = specByName.get(`${candidate.agent}-${String(candidate.number)}`)
          if (spec === undefined) continue // this agent was already dropped — nothing here to gate

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
            keptSpecs.push(spec)
            keptCandidates.push(candidate)
            if (priorHolds > 0) notes.push({ kind: 'held-dispatched', number: candidate.number })
            continue
          }
          if (route.action === 'hold') {
            notes.push({ kind: 'held', number: candidate.number, line: result.line })
            continue
          }

          // route.action === 'escalate'
          const needsHumanLabel = labelName(entry.config.vocabulary, 'needsHuman') ?? 'needsHuman'
          const triggerLabel = labelName(entry.config.vocabulary, candidate.trigger) ?? candidate.trigger
          const escalation = await deps.escalate({
            entry,
            kind: candidate.kind,
            number: candidate.number,
            trigger: candidate.trigger,
            viewer,
            body: escalationBody(result.line),
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

        gatedSpecs = keptSpecs
        sentCandidates = keptCandidates
        state.budget = { line: state.budget?.line ?? null, problem: state.budget?.problem ?? null, notes: notes.length > NOTE_LIMIT ? notes.slice(notes.length - NOTE_LIMIT) : notes }
      }

      if (gatedSpecs.length === 0) {
        report(entry.id, owner, missing !== null ? { kind: 'agents-missing', agent: missing } : { kind: 'idle' }, draining)
        return
      }

      if (state.sessionKey === null) return // defensive: ensureSession always sets this on success
      deps.store.send(state.sessionKey, composeDispatchTurn(gatedSpecs))

      const at = deps.now().toISOString()
      const sent: DispatchRecord[] = sentCandidates.map((c) => ({ agent: c.agent, number: c.number, kind: c.kind, state: 'sent', at }))
      pushRecent(entry.id, [...stateFor(entry.id).recent, ...sent])

      report(entry.id, owner, missing !== null ? { kind: 'agents-missing', agent: missing } : { kind: 'active', recent: stateFor(entry.id).recent }, draining)
    } finally {
      inFlight.delete(entry.id)
    }
  }

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    const list = await deps.listRepositories(deps.registryDeps)
    if (!list.ok) return
    const readyEntries = list.repositories.filter((entry): entry is ReadyEntry => 'config' in entry)
    const tickByRepo = new Map(snapshot.tick.map((t) => [t.repoId, t] as const))
    const repoByRepo = new Map(snapshot.state.repositories.filter((r): r is Extract<typeof r, { readonly ok: true }> => r.ok).map((r) => [r.repoId, r] as const))
    const viewerByRepo = new Map([...repoByRepo.entries()].map(([repoId, r]) => [repoId, r.viewer] as const))
    await Promise.all(readyEntries.map((entry) => considerRepo(entry, tickByRepo.get(entry.id), viewerByRepo.get(entry.id) ?? null, repoByRepo.get(entry.id))))
  }

  function status(): readonly RepoDispatchStatus[] {
    return [...repoStates.entries()].map(([repoId, s]) => ({
      repoId,
      owner: s.owner,
      state: s.dispatcherState,
      draining: s.draining,
      claudeSessionId: s.sessionKey !== null ? (deps.store.snapshotOf(s.sessionKey)?.claudeSessionId ?? null) : null,
      claimedAt: s.claimedAt,
      budget: s.budget,
      observed: s.observed,
    }))
  }

  function startedTasks(repoId: RepoId): readonly string[] {
    const state = repoStates.get(repoId)
    if (state === undefined || state.sessionKey === null) return []
    const snap = deps.store.snapshotOf(state.sessionKey)
    return snap?.tasks.filter((t) => t.status === 'started').map((t) => t.description) ?? []
  }

  function relay(params: { readonly repoId: RepoId; readonly agentId: string; readonly text: string }): Promise<DispatchRelayResult> {
    const state = repoStates.get(params.repoId)
    if (state === undefined || state.owner !== 'app' || state.sessionKey === null) return Promise.resolve({ ok: false, kind: 'not-owner' })
    const snap = deps.store.snapshotOf(state.sessionKey)
    if (snap === null) return Promise.resolve({ ok: false, kind: 'no-dispatcher' })
    const known = snap.tasks.some((t) => t.taskId === params.agentId || t.toolUseId === params.agentId)
    if (!known) return Promise.resolve({ ok: false, kind: 'unknown-agent' })
    deps.store.send(state.sessionKey, composeRelayTurn(params.agentId, params.text))
    return Promise.resolve({ ok: true })
  }

  async function stopFor(repoId: RepoId, number: number): Promise<boolean> {
    const state = repoStates.get(repoId)
    if (state === undefined || state.sessionKey === null) return false
    const record = state.recent.find((r) => r.number === number && r.state === 'started')
    if (record === undefined) return false
    const snap = deps.store.snapshotOf(state.sessionKey)
    const description = `${record.agent} #${String(number)}`
    const subagentType = `port:${record.agent}-agent`
    const task = snap?.tasks.find((t) => t.description === description && t.subagentType === subagentType && t.status === 'started')
    if (task === undefined) return false
    const result = await deps.store.stopTask(state.sessionKey, task.taskId)
    return result.ok
  }

  return { consider, status, relay, stopFor, startedTasks }
}

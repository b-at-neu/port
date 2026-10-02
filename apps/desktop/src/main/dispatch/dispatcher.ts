// #265: the app's own dispatcher — the composition root that turns a
// `BoardSnapshot` into real `Agent()` calls, the same way the cockpit's own
// tick does, through a hosted dispatcher session rather than a Claude Code
// session of its own. `consider` is the one entry point `main/ipc.ts` wires
// to `onSnapshot`; `status`/`relay`/`stopFor` serve the renderer's own
// reads and writes.
import type { BoardSnapshot } from '../../shared/board/types'
import type { DispatchOwner, DispatchRecord, DispatchRelayResult, DispatcherState, RepoDispatchStatus } from '../../shared/dispatch/types'
import type { DrainState } from '../../shared/dispatch/types'
import type { RepoId } from '../../shared/repos'
import type { AgentSummary, HostedSessionSnapshot, HostedStore, SessionKey } from '../hosting'
import type { ReadyEntry } from '../actions'
import type { RegistryDeps } from '../registry'
import type { DispatchLedger } from '../tick'
import { dispatchableFrom } from '../tick'
import type { ReadGateClaimParams } from '../writes'
import type { ClaimRead } from '../writes'
import type { FetchItemsByNumberParams } from '../github'
import type { ItemsByNumberFetch, ResolvedItem } from '../../shared/github/types'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { TickActionable, TickReport } from '../../shared/tick/types'
import { confirmStarted, markUnconfirmed, selectDispatches } from './select'
import { composeDispatchTurn, composeRelayTurn, DISPATCHER_INSTRUCTIONS, DISPATCHER_MODEL, missingAgentOf, specFor } from './turn'

const RECENT_LIMIT = 20

export interface CreateDispatcherParams {
  readonly store: HostedStore
  readonly ledger: DispatchLedger
  /** The app-wide drain switch's own `current()` — read fresh every pass,
   *  never cached, the same rule the claim read below follows. */
  readonly drain: () => DrainState
  readonly readGateClaim: (params: ReadGateClaimParams) => Promise<ClaimRead>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly listRepositories: (registryDeps: RegistryDeps) => Promise<{ readonly ok: boolean; readonly repositories?: readonly ReadyEntry[] }>
  readonly registryDeps: RegistryDeps
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
}

interface RepoDispatcherState {
  sessionKey: SessionKey | null
  recent: DispatchRecord[]
  owner: DispatchOwner
  dispatcherState: DispatcherState
  draining: boolean
}

function emptyRepoState(): RepoDispatcherState {
  return { sessionKey: null, recent: [], owner: 'cockpit', dispatcherState: { kind: 'idle' }, draining: false }
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
  if (resolved.labels.some((name) => name !== triggerLabel.name && roleBearingNames.has(name))) return false
  return resolved.assignees.includes(viewer)
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

  async function ensureSession(entry: ReadyEntry, repoId: RepoId): Promise<HostedSessionSnapshot | null> {
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
      report(repoId, 'app', { kind: 'dispatcher-failed', reason: started.kind === 'at-capacity' ? 'at-capacity' : 'runtime' }, false)
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

  async function considerRepo(entry: ReadyEntry, tick: TickReport | undefined, viewer: string | null): Promise<void> {
    if (inFlight.has(entry.id)) return
    inFlight.add(entry.id)
    try {
      const claim = await deps.readGateClaim({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      const owner = ownerOf(claim)
      const draining = deps.drain().gate !== 'open'
      if (owner !== 'app') {
        report(entry.id, owner, { kind: 'idle' }, draining)
        return
      }

      if (entry.config.commands.budget !== null) {
        report(entry.id, owner, { kind: 'refused', reason: 'budget-unported' }, draining)
        return
      }

      const state = stateFor(entry.id)

      // Confirm any already-sent records against the live session's own
      // task view, before computing new candidates — the floor (below)
      // reads each record's own `at`, regardless of state.
      if (state.sessionKey !== null) {
        const snap = deps.store.snapshotOf(state.sessionKey)
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

      if (tick === undefined || tick.blind !== null || viewer === null) {
        const recent = stateFor(entry.id).recent
        report(entry.id, owner, recent.length > 0 ? { kind: 'active', recent } : { kind: 'idle' }, draining)
        return
      }

      const dispatchable = dispatchableFrom(tick, deps.drain())
      const candidates = selectDispatches({ dispatchable, recent: stateFor(entry.id).recent, now: deps.now() })
      if (candidates.length === 0) {
        const recent = stateFor(entry.id).recent
        report(entry.id, owner, recent.length > 0 ? { kind: 'active', recent } : { kind: 'idle' }, draining)
        return
      }

      const snapshot = await ensureSession(entry, entry.id)
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
      const sentCandidates = survivors.filter((c) => resolvableNumbers.has(`${c.agent}-${String(c.number)}`))

      if (state.sessionKey === null) return // defensive: ensureSession always sets this on success
      deps.store.send(state.sessionKey, composeDispatchTurn(specs))

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
    if (!list.ok || list.repositories === undefined) return
    const tickByRepo = new Map(snapshot.tick.map((t) => [t.repoId, t] as const))
    const viewerByRepo = new Map(snapshot.state.repositories.filter((r): r is Extract<typeof r, { readonly ok: true }> => r.ok).map((r) => [r.repoId, r.viewer] as const))
    await Promise.all(list.repositories.map((entry) => considerRepo(entry, tickByRepo.get(entry.id), viewerByRepo.get(entry.id) ?? null)))
  }

  function status(): readonly RepoDispatchStatus[] {
    return [...repoStates.entries()].map(([repoId, s]) => ({ repoId, owner: s.owner, state: s.dispatcherState, draining: s.draining }))
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

  return { consider, status, relay, stopFor }
}

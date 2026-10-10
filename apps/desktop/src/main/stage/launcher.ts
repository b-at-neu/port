// The real StageLauncher: a worktree, a hosted session, a send, and the hand-back watcher that closes and removes it.
import type { GitRunner } from '../platform/git'
import type { CreateSessionWorktreeParams, CreateSessionWorktreeResult, RemoveSessionWorktreeOutcome } from '../workspace/worktree'
import type { StageLaunchRequest, StageLaunchResult, StageLauncher } from '../dispatch/launch'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult } from '../../shared/hosting/types'
import type { HostedStore } from '../hosting/store'
import type { StageOutcome } from '../../shared/hosting/stage'
import type { RepoId } from '../../shared/repos'
import type { StageDenial } from '../../shared/stage/types'
import { proposedRule } from '../../shared/stage/rule'
import { STAGE_AGENT_NAMES } from './agents'
import { classifyHandback } from './handback'
import type { StageRegistry } from './registry'
import { inFlightKeyFor } from '../tick/routing'

const DENIAL_INPUT_SUMMARY_CAP = 200

function inputSummaryOf(input: Readonly<Record<string, unknown>>): string {
  const text = typeof input.command === 'string' ? input.command : JSON.stringify(input)
  return text.length > DENIAL_INPUT_SUMMARY_CAP ? `${text.slice(0, DENIAL_INPUT_SUMMARY_CAP)}…` : text
}

export interface CreateStageLauncherParams {
  readonly store: HostedStore
  readonly git: GitRunner
  readonly createWorktree: (params: CreateSessionWorktreeParams) => Promise<CreateSessionWorktreeResult>
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly now: () => Date
  readonly onOutcome: (repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome) => void
  /** `stage-sessions.json`'s sole writer — every launch records `running` here, every hand-back clears or marks it. */
  readonly registry: StageRegistry
  /** The policy's `deny` arm, turned into a `StageDenial` — deduped and bounded on the dispatcher's own side. */
  readonly onDenial: (repoId: RepoId, denial: StageDenial) => void
  readonly newId: () => string
}

export interface StageLauncherHandle extends StageLauncher {
  /** Wired from `main/ipc.ts`'s own `onStatus` — classifies a hand-back once per new `lastResult`/`end`, serialized per session key. */
  observe(snapshot: HostedSessionSnapshot): void
}

/** The one place a failed `SessionStartResult` becomes a message for a dispatch record — never re-derived at a second call site. */
function startFailureMessage(result: Extract<SessionStartResult, { readonly ok: false }>): string {
  switch (result.kind) {
    case 'at-capacity':
      return `at capacity (limit ${String(result.limit)})`
    case 'runtime':
      return `runtime problem: ${result.diagnosis}${result.detail !== null ? ` (${result.detail})` : ''}`
    case 'already-open':
      return 'a session already has this id open'
    case 'folder-missing':
      return `the target folder is missing${result.path !== null ? `: ${result.path}` : ''}`
    case 'folder-busy':
      return 'the target folder already has a live session open'
    case 'not-git':
      return 'the target folder is not a git repository'
    case 'worktree-failed':
      return `git worktree add failed: ${result.message}`
  }
}

export function createStageLauncher(params: CreateStageLauncherParams): StageLauncherHandle {
  const tracked = new Map<SessionKey, { readonly repoId: RepoId; readonly registryId: string; lastSeenResultAt: string | null; sawSessionId: boolean }>()
  // Serializes observe() per session key so two status pushes for the same session never race the hand-back.
  let chain: Promise<void> = Promise.resolve()

  function serialize(fn: () => Promise<void>): void {
    chain = chain.then(fn, fn)
  }

  async function launch(request: StageLaunchRequest): Promise<StageLaunchResult> {
    const wt = await params.createWorktree({ root: request.entry.path, git: params.git })
    if (!wt.ok) return { ok: false, kind: 'failed', message: `Couldn't create the stage worktree: ${wt.message}` }

    const registryId = params.newId()
    const onDeny = (toolName: string, input: Readonly<Record<string, unknown>>): void => {
      params.onDenial(request.entry.id, {
        id: params.newId(),
        repoId: request.entry.id,
        agent: request.agent,
        number: request.number,
        toolName,
        inputSummary: inputSummaryOf(input),
        rule: proposedRule(toolName, input),
        at: params.now().toISOString(),
      })
    }

    const startResult = await params.store.start({
      repoId: request.entry.id,
      mode: { kind: 'fresh' },
      workspace: { folder: wt.path, root: request.entry.path, worktree: { path: wt.path, branch: wt.branch }, base: { sha: wt.baseSha, label: wt.branch } },
      stage: {
        tag: { agent: request.agent, number: request.number, kind: request.kind, trigger: request.trigger },
        agentName: STAGE_AGENT_NAMES[request.agent],
        model: request.model,
        sessionRequiredPaths: request.entry.config.sessionRequiredPaths,
        onDeny,
      },
    })

    if (!startResult.ok) {
      await params.removeWorktree(wt.path, false)
      if (startResult.kind === 'at-capacity') return { ok: false, kind: 'at-capacity', limit: startResult.limit }
      return { ok: false, kind: 'failed', message: startFailureMessage(startResult) }
    }

    const sessionKey = startResult.snapshot.sessionKey
    const sendResult = params.store.send(sessionKey, request.prompt)
    if (!sendResult.ok) {
      await params.store.close(sessionKey)
      await params.removeWorktree(wt.path, false)
      return { ok: false, kind: 'failed', message: `could not send the stage prompt: ${sendResult.kind}` }
    }

    tracked.set(sessionKey, { repoId: request.entry.id, registryId, lastSeenResultAt: null, sawSessionId: false })
    params.registry.recordRunning({
      id: registryId,
      repoId: request.entry.id,
      agent: request.agent,
      number: request.number,
      kind: request.kind,
      trigger: request.trigger,
      inFlight: inFlightKeyFor(request.agent, request.trigger),
      model: request.model,
      claudeSessionId: null,
      worktree: { path: wt.path, branch: wt.branch, baseSha: wt.baseSha },
      startedAt: params.now().toISOString(),
    })
    return { ok: true, sessionKey }
  }

  function observe(snapshot: HostedSessionSnapshot): void {
    const entry = tracked.get(snapshot.sessionKey)
    if (entry === undefined) return

    if (!entry.sawSessionId && snapshot.claudeSessionId !== null) {
      entry.sawSessionId = true
      params.registry.setSessionId(entry.registryId, snapshot.claudeSessionId)
    }

    const resultAt = snapshot.lastResult?.at ?? null
    const newResult = resultAt !== null && resultAt !== entry.lastSeenResultAt
    const atEnd = snapshot.phase === 'ended'
    if (!newResult && !atEnd) return
    entry.lastSeenResultAt = resultAt

    const outcome = classifyHandback({ lastResult: snapshot.lastResult, end: snapshot.end, rateLimit: snapshot.rateLimit, usage: snapshot.usage, phase: snapshot.phase })
    if (outcome === null) return

    serialize(() => settle(snapshot.sessionKey, entry.repoId, entry.registryId, outcome))
  }

  async function settle(sessionKey: SessionKey, repoId: RepoId, registryId: string, outcome: StageOutcome): Promise<void> {
    try {
      if (outcome.kind === 'questions' || outcome.kind === 'blocked') {
        // The session is still open — the registry entry stays `running`.
        params.onOutcome(repoId, sessionKey, outcome)
        return
      }

      if (outcome.kind === 'completed') {
        await params.store.close(sessionKey)
        const dismissResult = await params.store.dismiss(sessionKey, 'remove')
        const worktree = dismissResult.ok ? 'removed' : dismissResult.kind === 'worktree-dirty' ? 'kept-dirty' : dismissResult.kind === 'worktree-remove-failed' ? 'remove-failed' : outcome.worktree
        tracked.delete(sessionKey)
        params.registry.remove(registryId)
        params.onOutcome(repoId, sessionKey, { ...outcome, worktree })
        return
      }

      // error, usage-limit, interrupted: close the session where needed, keep the worktree, and mark it.
      if (outcome.kind === 'error' || outcome.kind === 'usage-limit') await params.store.close(sessionKey)
      tracked.delete(sessionKey)
      // `crash`/`quit` are reserved for a boot-time find and the quit path's own `markAllQuit`.
      const reason = outcome.kind === 'usage-limit' ? 'usage-limit' : 'error'
      params.registry.markInterrupted(registryId, reason, outcome.detail, outcome.resetsAt, outcome.costUsd)
      params.onOutcome(repoId, sessionKey, outcome)
    } catch (error) {
      tracked.delete(sessionKey)
      const message = error instanceof Error ? error.message : String(error)
      params.registry.markInterrupted(registryId, 'error', `hand-back settle failed: ${message}`, null, outcome.costUsd)
      params.onOutcome(repoId, sessionKey, { kind: 'error', detail: `hand-back settle failed: ${message}`, costUsd: outcome.costUsd, resetsAt: null, worktree: 'remove-failed' })
    }
  }

  return { launch, observe }
}

import type { HostedStore } from '@/types/hosting'
import type { StageRegistry } from '@/types/stage'

// The real StageLauncher: a worktree, a hosted session, a send, and the hand-back watcher that closes and removes it.
import type { FileResult, GitRunner, PathOps } from '@/types/platform'
import type { CreateStageWorktreeParams, CreateStageWorktreeResult, ReleaseBranchOutcome, RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { StageLaunchRequest, StageLaunchResult } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionDismissResult, SessionKey, SessionStartResult } from '@/types/hosting'

import type { StageOutcome, StageOutcomeKind } from '@/types/stage-session'
import type { StagePlanFile } from '@/types/stage-labels'
import type { StageAgent } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import type { InterruptedStage, StageDenial, StageInstructionsLoader, StageResumeRequest } from '@/types/stage'
import { RESUME_PROMPT } from '@/main/stage/recover'
import { isTransientNetworkFailure, SETTLE_FAILED_DETAIL } from '@/main/pipeline/handback'
import { proposedRule } from '@/main/stage/rule'
import { loadStageAgentDefinition } from '@/main/stage/bundle'
import { classifyHandback } from '@/main/pipeline/handback'
import { stageTitle } from '@/main/sessions/hosting/title'
import { bareTicketLabel } from '@/utils/tickets/ticket'

import { inFlightKeyFor } from '@/main/pipeline/tick/routing'
import type { StageLauncherHandle } from '@/types/stage'

const DENIAL_INPUT_SUMMARY_CAP = 200

function inputSummaryOf(input: Readonly<Record<string, unknown>>): string {
  const text = typeof input.command === 'string' ? input.command : JSON.stringify(input)
  return text.length > DENIAL_INPUT_SUMMARY_CAP ? `${text.slice(0, DENIAL_INPUT_SUMMARY_CAP)}…` : text
}

interface CreateStageLauncherParams {
  readonly store: HostedStore
  readonly git: GitRunner
  readonly createWorktree: (params: CreateStageWorktreeParams) => Promise<CreateStageWorktreeResult>
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly releaseBranch: (root: string, branch: string, baseSha: string) => Promise<ReleaseBranchOutcome>
  /** Runs once per repository root per process, never awaited as a gate. */
  readonly sweepBranches: (root: string) => Promise<unknown>
  readonly now: () => Date
  /** `plan` is non-null only for a completed `plan-written` hand-back. */
  readonly onOutcome: (repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome, plan: StagePlanFile | null) => void
  /** Fired once when a session that handed back `blocked` starts its next turn. */
  readonly onResumedTurn: (repoId: RepoId, sessionKey: SessionKey) => void
  /** `stage-sessions.json`'s sole writer — every launch records `running` here, every hand-back clears or marks it. */
  readonly registry: StageRegistry
  /** The policy's `deny` arm, turned into a `StageDenial` — deduped and bounded on the dispatcher's own side. */
  readonly onDenial: (repoId: RepoId, denial: StageDenial) => void
  readonly newId: () => string
  /** The first message's composed text and the inline agent, loaded from the bundled stage prompts; a failure fails the launch. */
  readonly loadInstructions: StageInstructionsLoader
  /** The app's own `stage-prompts` folder, which a stage session may read. */
  readonly bundleRoot: string
  readonly readTextFile: (path: string) => Promise<FileResult<string>>
  readonly pathExists: (path: string) => Promise<boolean>
  /** Fired when `resume` starts an interrupted entry as a session, so its hand-back settles labels. */
  readonly onResumed: (repoId: RepoId, sessionKey: SessionKey, entry: InterruptedStage) => void
  readonly ops: Pick<PathOps, 'join' | 'samePath'>
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

function cleanupFailureDetail(result: Exclude<SessionDismissResult, { readonly ok: true }>): string {
  switch (result.kind) {
    case 'worktree-dirty':
      return 'it has uncommitted changes'
    case 'worktree-remove-failed':
      return result.message.trim()
    case 'unknown-session':
    case 'still-open':
      return `the session could not be dismissed (${result.kind})`
  }
}

export function createStageLauncher(params: CreateStageLauncherParams): StageLauncherHandle {
  const tracked = new Map<SessionKey, { readonly repoId: RepoId; readonly registryId: string; readonly agent: StageAgent; readonly number: number; readonly path: string; readonly root: string; readonly branch: string | null; readonly baseSha: string; lastSeenResultAt: string | null; sawSessionId: boolean; lastOutcome: StageOutcomeKind | null; blockedIdle: boolean }>()
  const swept = new Set<string>()

  async function removeAndRelease(root: string, path: string, branch: string | null, baseSha: string): Promise<RemoveSessionWorktreeOutcome> {
    const removed = await params.removeWorktree(path, false)
    if (removed.outcome === 'removed' && branch !== null) await params.releaseBranch(root, branch, baseSha)
    return removed
  }
  // Serializes observe() per session key so two status pushes for the same session never race the hand-back.
  let chain: Promise<void> = Promise.resolve()

  function serialize(fn: () => Promise<void>): void {
    chain = chain.then(fn, fn)
  }

  // `sessionKey` is read lazily: a denial can only fire after the session exists, never inside `start`.
  function denialRecorder(repoId: RepoId, agent: StageDenial['agent'], number: number, sessionKey: () => SessionKey | null) {
    return (toolName: string, input: Readonly<Record<string, unknown>>): void => {
      params.onDenial(repoId, {
        id: params.newId(),
        repoId,
        agent,
        number,
        toolName,
        inputSummary: inputSummaryOf(input),
        rule: proposedRule(toolName, input),
        at: params.now().toISOString(),
        sessionKey: sessionKey(),
      })
    }
  }

  /** An operator's or the sweeper's resume: the same session start, then the dispatcher is told so its hand-back settles labels. */
  async function resume(request: StageResumeRequest): Promise<StageLaunchResult> {
    const result = await startResume(request)
    if (result.ok) params.onResumed(request.entry.repoId, result.sessionKey, request.entry)
    return result
  }

  async function startResume(request: StageResumeRequest): Promise<StageLaunchResult> {
    const { entry, root, prompt } = request
    if (entry.claudeSessionId === null) return { ok: false, kind: 'failed', message: 'the session ended before Claude started it', cause: 'resume' }

    const definition = await loadStageAgentDefinition({ root: params.bundleRoot, agent: entry.agent, ops: params.ops, readTextFile: params.readTextFile })
    if (!definition.ok) return { ok: false, kind: 'failed', message: definition.message, cause: 'resume' }

    let sessionKey: SessionKey | null = null
    const startResult = await params.store.start({
      repoId: entry.repoId,
      mode: { kind: 'resume', sessionId: entry.claudeSessionId },
      initialTitle: stageTitle(entry.title ?? bareTicketLabel(entry.number, entry.kind)),
      workspace: {
        folder: entry.worktree.path,
        root: root.path,
        worktree: { path: entry.worktree.path, branch: entry.worktree.branch },
        base: { sha: entry.worktree.baseSha, label: entry.worktree.branch ?? 'detached' },
      },
      stage: {
        tag: { agent: entry.agent, number: entry.number, kind: entry.kind, trigger: entry.trigger },
        agent: { name: definition.name, definition: definition.definition },
        instructionsRoot: params.bundleRoot,
        model: entry.model,
        sessionRequiredPaths: root.sessionRequiredPaths,
        onDeny: denialRecorder(entry.repoId, entry.agent, entry.number, () => sessionKey),
      },
    })
    if (!startResult.ok) {
      if (startResult.kind === 'at-capacity') return { ok: false, kind: 'at-capacity', limit: startResult.limit }
      return { ok: false, kind: 'failed', message: startFailureMessage(startResult), cause: 'resume' }
    }

    sessionKey = startResult.snapshot.sessionKey
    const sendResult = params.store.send(sessionKey, prompt)
    if (!sendResult.ok) {
      await params.store.close(sessionKey)
      return { ok: false, kind: 'failed', message: `could not send the resume prompt: ${sendResult.kind}`, cause: 'resume' }
    }

    tracked.set(sessionKey, { repoId: entry.repoId, registryId: entry.id, agent: entry.agent, number: entry.number, path: entry.worktree.path, root: root.path, branch: entry.worktree.branch, baseSha: entry.worktree.baseSha, lastSeenResultAt: null, sawSessionId: false, lastOutcome: null, blockedIdle: false })
    params.registry.markRunning(entry.id)
    return { ok: true, sessionKey }
  }

  /** An interrupted entry for this ticket and agent, with its session and worktree intact and no reset still pending, is resumed instead of launched fresh — its work is kept. `null` falls through to a fresh launch. */
  async function resumeInterrupted(request: StageLaunchRequest): Promise<StageLaunchResult | null> {
    const entry = params.registry.list().find((e) => e.repoId === request.entry.id && e.number === request.number && e.agent === request.agent && e.claudeSessionId !== null && (e.resetsAt === null || Date.parse(e.resetsAt) <= params.now().getTime()))
    if (entry === undefined || !(await params.pathExists(entry.worktree.path))) return null
    const result = await startResume({ entry, root: { path: request.entry.path, sessionRequiredPaths: request.entry.config.sessionRequiredPaths }, prompt: RESUME_PROMPT.replace('<n>', String(entry.number)) })
    return result.ok ? result : null
  }

  async function launch(request: StageLaunchRequest): Promise<StageLaunchResult> {
    const root = request.entry.path
    if (!swept.has(root)) {
      swept.add(root)
      void params.sweepBranches(root).catch(() => undefined)
    }

    const resumed = await resumeInterrupted(request)
    if (resumed !== null) return resumed

    // Only a live hosted session holds a worktree: a registry `running` entry whose session died must not block the reclaim.
    const liveWorktrees = new Set<string>()
    for (const snapshot of params.store.list()) {
      if (snapshot.phase !== 'ended' && snapshot.workspace.worktree !== null) liveWorktrees.add(snapshot.workspace.worktree.path)
    }

    const wt = await params.createWorktree({ root, git: params.git, agent: request.agent, number: request.number, integration: request.entry.config.branches.integration, target: request.target, liveWorktrees })
    if (!wt.ok) return { ok: false, kind: 'failed', message: `Couldn't create the stage worktree: ${wt.message}`, cause: wt.leftover === true ? 'leftover-worktree' : 'worktree' }

    const reclaimed = wt.reclaimed
    if (reclaimed !== null) {
      for (const superseded of params.registry.list()) {
        if (params.ops.samePath(superseded.worktree.path, reclaimed)) params.registry.remove(superseded.id)
      }
    }

    const instructions = await params.loadInstructions(request, wt.path)
    if (!instructions.ok) {
      await removeAndRelease(root, wt.path, wt.branch, wt.baseSha)
      return { ok: false, kind: 'failed', message: `Couldn't load the stage instructions from the app's bundled stage prompts: ${instructions.message}`, cause: 'instructions' }
    }

    const registryId = params.newId()
    let launchedKey: SessionKey | null = null
    const onDeny = denialRecorder(request.entry.id, request.agent, request.number, () => launchedKey)

    const startResult = await params.store.start({
      repoId: request.entry.id,
      mode: { kind: 'fresh' },
      initialTitle: stageTitle(request.title),
      workspace: { folder: wt.path, root: request.entry.path, worktree: { path: wt.path, branch: wt.branch }, base: { sha: wt.baseSha, label: wt.baseLabel } },
      stage: {
        tag: { agent: request.agent, number: request.number, kind: request.kind, trigger: request.trigger },
        agent: instructions.agent,
        instructionsRoot: params.bundleRoot,
        model: request.model,
        sessionRequiredPaths: request.entry.config.sessionRequiredPaths,
        onDeny,
      },
    })

    if (!startResult.ok) {
      await removeAndRelease(root, wt.path, wt.branch, wt.baseSha)
      if (startResult.kind === 'at-capacity') return { ok: false, kind: 'at-capacity', limit: startResult.limit }
      return { ok: false, kind: 'failed', message: startFailureMessage(startResult), cause: 'start' }
    }

    const sessionKey = startResult.snapshot.sessionKey
    launchedKey = sessionKey
    const sendResult = params.store.send(sessionKey, instructions.text)
    if (!sendResult.ok) {
      await params.store.close(sessionKey)
      await removeAndRelease(root, wt.path, wt.branch, wt.baseSha)
      return { ok: false, kind: 'failed', message: `could not send the stage prompt: ${sendResult.kind}`, cause: 'prompt' }
    }

    tracked.set(sessionKey, { repoId: request.entry.id, registryId, agent: request.agent, number: request.number, path: wt.path, root, branch: wt.branch, baseSha: wt.baseSha, lastSeenResultAt: null, sawSessionId: false, lastOutcome: null, blockedIdle: false })
    params.registry.recordRunning({
      id: registryId,
      repoId: request.entry.id,
      agent: request.agent,
      number: request.number,
      kind: request.kind,
      trigger: request.trigger,
      inFlight: inFlightKeyFor(request.agent, request.trigger),
      model: request.model,
      title: request.title,
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
    if (!newResult && !atEnd) {
      if (entry.lastOutcome !== 'blocked') return
      if (snapshot.phase !== 'streaming') entry.blockedIdle = true
      else if (entry.blockedIdle) {
        entry.lastOutcome = null
        entry.blockedIdle = false
        params.onResumedTurn(entry.repoId, snapshot.sessionKey)
      }
      return
    }
    entry.lastSeenResultAt = resultAt

    const outcome = classifyHandback({
      lastResult: snapshot.lastResult,
      end: snapshot.end,
      rateLimit: snapshot.rateLimit,
      usage: snapshot.usage,
      phase: snapshot.phase,
      operatorJoinedAt: snapshot.operatorJoinedAt,
    })
    if (outcome === null) return
    entry.lastOutcome = outcome.kind
    entry.blockedIdle = outcome.kind === 'blocked' && snapshot.phase !== 'streaming'

    serialize(() => settle(snapshot.sessionKey, entry.repoId, entry.registryId, outcome))
  }

  /** Read before the worktree is removed; only a completed `plan-written` hand-back carries a plan. */
  async function readPlanFile(sessionKey: SessionKey, outcome: StageOutcome): Promise<StagePlanFile | null> {
    const held = tracked.get(sessionKey)
    if (held === undefined || held.agent !== 'plan' || outcome.handback?.token !== 'plan-written') return null
    const read = await params.readTextFile(params.ops.join(held.path, '.temp', `plan-${String(held.number)}.md`))
    if (!read.ok) return { kind: 'missing', detail: read.kind === 'not-found' ? null : read.message }
    return read.value.trim() === '' ? { kind: 'empty' } : { kind: 'read', body: read.value }
  }

  async function settle(sessionKey: SessionKey, repoId: RepoId, registryId: string, outcome: StageOutcome): Promise<void> {
    try {
      if (outcome.kind === 'questions' || outcome.kind === 'blocked') {
        // The session is still open — the registry entry stays `running`.
        params.onOutcome(repoId, sessionKey, outcome, null)
        return
      }

      if (outcome.kind === 'completed') {
        await params.store.close(sessionKey)
        const plan = await readPlanFile(sessionKey, outcome)
        const dismissResult = await params.store.dismiss(sessionKey, 'remove')
        const held = tracked.get(sessionKey)
        if (dismissResult.ok && held !== undefined && held.branch !== null) await params.releaseBranch(held.root, held.branch, held.baseSha)
        const worktree = dismissResult.ok ? 'removed' : dismissResult.kind === 'worktree-dirty' ? 'kept-dirty' : dismissResult.kind === 'worktree-remove-failed' ? 'remove-failed' : outcome.worktree
        tracked.delete(sessionKey)
        if (dismissResult.ok) params.registry.remove(registryId)
        else params.registry.markInterrupted(registryId, 'cleanup-failed', cleanupFailureDetail(dismissResult), null, outcome.costUsd)
        params.onOutcome(repoId, sessionKey, { ...outcome, worktree }, plan)
        return
      }

      // error, usage-limit, interrupted: close the session where needed, keep the worktree, and mark it.
      if (outcome.kind === 'error' || outcome.kind === 'usage-limit' || outcome.kind === 'interrupted') await params.store.close(sessionKey)
      tracked.delete(sessionKey)
      // `crash`/`quit` are reserved for a boot-time find and the quit path's own `markAllQuit`.
      const reason = outcome.kind === 'usage-limit' ? 'usage-limit' : outcome.kind === 'interrupted' && isTransientNetworkFailure(outcome.detail) ? 'network' : 'error'
      params.registry.markInterrupted(registryId, reason, outcome.detail, outcome.resetsAt, outcome.costUsd)
      params.onOutcome(repoId, sessionKey, outcome, null)
    } catch (error) {
      tracked.delete(sessionKey)
      const message = error instanceof Error ? error.message : String(error)
      params.registry.markInterrupted(registryId, 'error', `${SETTLE_FAILED_DETAIL}: ${message}`, null, outcome.costUsd)
      params.onOutcome(repoId, sessionKey, { kind: 'error', detail: `${SETTLE_FAILED_DETAIL}: ${message}`, costUsd: outcome.costUsd, resetsAt: null, worktree: 'remove-failed', operatorJoined: outcome.operatorJoined, handback: null }, null)
    }
  }

  return { launch, observe, resume }
}

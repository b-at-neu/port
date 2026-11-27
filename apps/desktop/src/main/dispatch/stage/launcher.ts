// The real StageLauncher: a worktree, a hosted session, a send, and the hand-back watcher that closes and removes it.
import type { RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { StageLaunchRequest, StageLaunchResult } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionDismissResult, SessionKey, SessionStartResult } from '@/types/hosting'

import type { StageOutcome, StageOutcomeKind } from '@/types/stage-session'
import type { StagePlanFile } from '@/types/stage-labels'
import type { StageAgent } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import type { StageResumeRequest } from '@/types/stage'
import type { Run } from '@/utils/pipeline/ticket'
import type { StageLaunchContext } from '@/main/dispatch/context'
import { RESUME_PROMPT } from '@/main/dispatch/stage/recover'
import { loadStageLaunch } from '@/main/dispatch/stage/instructions'
import { pathOps } from '@/main/platform/paths'
import { readStagePrompt, stagePromptsDir } from '@/main/sessions/hosting/stage-prompt-store'
import { createStageWorktree, releaseStageBranch, sweepSessionBranches } from '@/main/repos/worktree/stage-worktree'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import { isTransientNetworkFailure, SETTLE_FAILED_DETAIL } from '@/main/pipeline/handback'
import { proposedRule } from '@/main/dispatch/stage/rule'
import { LEGACY_STAGE_SYSTEM_PROMPT, loadStageAgentDefinition } from '@/main/dispatch/stage/bundle'
import { classifyHandback } from '@/main/pipeline/handback'
import { stageTitle } from '@/main/sessions/hosting/title'
import { bareTicketLabel } from '@/utils/tickets/ticket'

import type { StageLauncherHandle } from '@/types/stage'

const DENIAL_INPUT_SUMMARY_CAP = 200

function inputSummaryOf(input: Readonly<Record<string, unknown>>): string {
  const text = typeof input.command === 'string' ? input.command : JSON.stringify(input)
  return text.length > DENIAL_INPUT_SUMMARY_CAP ? `${text.slice(0, DENIAL_INPUT_SUMMARY_CAP)}…` : text
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

/** `bundleRoot` is the app's own `stage-prompts` folder, which a stage session may read. */
export function createStageLauncher(ctx: StageLaunchContext, bundleRoot: string): StageLauncherHandle {
  const runs = ctx.stores.runs
  const tracked = new Map<SessionKey, { readonly repoId: RepoId; readonly runId: string; readonly agent: StageAgent; readonly number: number; readonly path: string; readonly root: string; readonly branch: string | null; readonly baseSha: string; lastSeenResultAt: string | null; sawSessionId: boolean; lastOutcome: StageOutcomeKind | null; blockedIdle: boolean }>()
  const swept = new Set<string>()

  async function removeAndRelease(root: string, path: string, branch: string | null, baseSha: string): Promise<RemoveSessionWorktreeOutcome> {
    const removed = await removeSessionWorktreeAt(ctx, { path, force: false })
    if (removed.outcome === 'removed' && branch !== null) await releaseStageBranch(ctx, { root, branch, baseSha })
    return removed
  }
  // Serializes observe() per session key so two status pushes for the same session never race the hand-back.
  let chain: Promise<void> = Promise.resolve()

  function serialize(fn: () => Promise<void>): void {
    chain = chain.then(fn, fn)
  }

  /** A denial can only fire once the session exists, and lands on its run. */
  function denialRecorder(repoId: RepoId, runId: string) {
    return (toolName: string, input: Readonly<Record<string, unknown>>): void => {
      void runs.denied(repoId, runId, { id: globalThis.crypto.randomUUID(), toolName, inputSummary: inputSummaryOf(input), rule: proposedRule(toolName, input), at: ctx.clock.now().toISOString() })
    }
  }

  /** An operator's or the sweeper's resume: the kept worktree as a session again, its run open once more. */
  async function resume(request: StageResumeRequest): Promise<StageLaunchResult> {
    const { entry, root, prompt } = request
    if (entry.claudeSessionId === null) return { ok: false, kind: 'failed', message: 'the session ended before Claude started it', cause: 'resume' }

    // Never rebuilt from the live bundle and config: that would change a running session's stage context.
    const saved = await readStagePrompt(ctx.fs, stagePromptsDir(ctx.paths.userData), entry.claudeSessionId)
    const definition = await loadStageAgentDefinition(ctx, { root: bundleRoot, agent: entry.agent, prompt: saved ?? LEGACY_STAGE_SYSTEM_PROMPT })
    if (!definition.ok) return { ok: false, kind: 'failed', message: definition.message, cause: 'resume' }

    const startResult = await ctx.live.hostedStore.start({
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
        tag: { agent: entry.agent, number: entry.number, kind: entry.kind },
        agent: { name: definition.name, definition: definition.definition, selfContained: saved !== null },
        instructionsRoot: bundleRoot,
        model: entry.model,
        sessionRequiredPaths: root.sessionRequiredPaths,
        onDeny: denialRecorder(entry.repoId, entry.id),
      },
    })
    if (!startResult.ok) {
      if (startResult.kind === 'at-capacity') return { ok: false, kind: 'at-capacity', limit: startResult.limit }
      return { ok: false, kind: 'failed', message: startFailureMessage(startResult), cause: 'resume' }
    }

    const sessionKey = startResult.snapshot.sessionKey
    const sendResult = ctx.live.hostedStore.send(sessionKey, prompt)
    if (!sendResult.ok) {
      await ctx.live.hostedStore.close(sessionKey)
      return { ok: false, kind: 'failed', message: `could not send the resume prompt: ${sendResult.kind}`, cause: 'resume' }
    }

    tracked.set(sessionKey, { repoId: entry.repoId, runId: entry.id, agent: entry.agent, number: entry.number, path: entry.worktree.path, root: root.path, branch: entry.worktree.branch, baseSha: entry.worktree.baseSha, lastSeenResultAt: null, sawSessionId: false, lastOutcome: null, blockedIdle: false })
    await runs.resumed(entry.repoId, entry.id, sessionKey)
    return { ok: true, sessionKey }
  }

  /** An interrupted entry for this ticket and agent, with its session and worktree intact and no reset still pending, is resumed instead of launched fresh — its work is kept. `null` falls through to a fresh launch. */
  async function resumeInterrupted(request: StageLaunchRequest): Promise<StageLaunchResult | null> {
    const entry = runs.list(request.entry.id).find((e) => e.repoId === request.entry.id && e.number === request.number && e.agent === request.agent && e.claudeSessionId !== null && (e.resetsAt === null || Date.parse(e.resetsAt) <= ctx.clock.now().getTime()))
    if (entry === undefined || !(await ctx.fs.exists(entry.worktree.path))) return null
    const result = await resume({ entry, root: { path: request.entry.path, sessionRequiredPaths: request.entry.config.sessionRequiredPaths }, prompt: RESUME_PROMPT.replace('<n>', String(entry.number)) })
    return result.ok ? result : null
  }

  async function launch(request: StageLaunchRequest): Promise<StageLaunchResult> {
    const root = request.entry.path
    if (!swept.has(root)) {
      swept.add(root)
      void sweepSessionBranches(ctx, root).catch(() => undefined)
    }

    const resumed = await resumeInterrupted(request)
    if (resumed !== null) return resumed

    // Only a live hosted session holds a worktree: an open run whose session died must not block the reclaim.
    const liveWorktrees = new Set<string>()
    for (const snapshot of ctx.live.hostedStore.list()) {
      if (snapshot.phase !== 'ended' && snapshot.workspace.worktree !== null) liveWorktrees.add(snapshot.workspace.worktree.path)
    }

    const wt = await createStageWorktree(ctx, { root, agent: request.agent, number: request.number, integration: request.entry.config.branches.integration, target: request.target, liveWorktrees })
    if (!wt.ok) return { ok: false, kind: 'failed', message: `Couldn't create the stage worktree: ${wt.message}`, cause: wt.leftover === true ? 'leftover-worktree' : 'worktree' }

    const reclaimed = wt.reclaimed
    if (reclaimed !== null) {
      for (const superseded of runs.list()) {
        if (pathOps.samePath(superseded.worktree.path, reclaimed)) await runs.cleared(superseded.repoId, superseded.id)
      }
    }

    const instructions = await loadStageLaunch(ctx, bundleRoot, request, wt.path)
    if (!instructions.ok) {
      await removeAndRelease(root, wt.path, wt.branch, wt.baseSha)
      return { ok: false, kind: 'failed', message: `Couldn't load the stage instructions from the app's bundled stage prompts: ${instructions.message}`, cause: 'instructions' }
    }

    const runId = globalThis.crypto.randomUUID()
    const onDeny = denialRecorder(request.entry.id, runId)

    const startResult = await ctx.live.hostedStore.start({
      repoId: request.entry.id,
      mode: { kind: 'fresh' },
      initialTitle: stageTitle(request.title),
      workspace: { folder: wt.path, root: request.entry.path, worktree: { path: wt.path, branch: wt.branch }, base: { sha: wt.baseSha, label: wt.baseLabel } },
      stage: {
        tag: { agent: request.agent, number: request.number, kind: request.kind },
        agent: instructions.agent,
        instructionsRoot: bundleRoot,
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
    const sendResult = ctx.live.hostedStore.send(sessionKey, instructions.text)
    if (!sendResult.ok) {
      await ctx.live.hostedStore.close(sessionKey)
      await removeAndRelease(root, wt.path, wt.branch, wt.baseSha)
      return { ok: false, kind: 'failed', message: `could not send the stage prompt: ${sendResult.kind}`, cause: 'prompt' }
    }

    tracked.set(sessionKey, { repoId: request.entry.id, runId, agent: request.agent, number: request.number, path: wt.path, root, branch: wt.branch, baseSha: wt.baseSha, lastSeenResultAt: null, sawSessionId: false, lastOutcome: null, blockedIdle: false })
    const run: Run = {
      id: runId,
      stage: request.stage,
      item: { kind: request.kind, number: request.number },
      agent: request.agent,
      model: request.model,
      title: request.title,
      sessionKey,
      claudeSessionId: null,
      worktree: { path: wt.path, branch: wt.branch, baseSha: wt.baseSha },
      startedAt: ctx.clock.now().toISOString(),
      endedAt: null,
      outcome: null,
      handback: null,
      costUsd: null,
      operatorJoinedAt: null,
      failure: null,
      interruption: null,
      networkRetries: 0,
      denials: [],
    }
    await runs.start(request.entry.id, run)
    return { ok: true, sessionKey }
  }

  function observe(snapshot: HostedSessionSnapshot): void {
    const entry = tracked.get(snapshot.sessionKey)
    if (entry === undefined || entry.lastOutcome === 'completed') return

    if (!entry.sawSessionId && snapshot.claudeSessionId !== null) {
      entry.sawSessionId = true
      void runs.session(entry.repoId, entry.runId, snapshot.claudeSessionId)
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
        ctx.live.dispatcher.recordResumedTurn(entry.repoId, snapshot.sessionKey)
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

    serialize(() => settle(snapshot.sessionKey, entry.repoId, entry.runId, outcome))
  }

  /** Read before the worktree is removed; only a completed `plan-written` hand-back carries a plan. */
  async function readPlanFile(sessionKey: SessionKey, outcome: StageOutcome): Promise<StagePlanFile | null> {
    const held = tracked.get(sessionKey)
    if (held === undefined || held.agent !== 'plan' || outcome.handback?.token !== 'plan-written') return null
    const read = await ctx.fs.readText(pathOps.join(held.path, '.temp', `plan-${String(held.number)}.md`))
    if (!read.ok) return { kind: 'missing', detail: read.kind === 'not-found' ? null : read.message }
    return read.value.trim() === '' ? { kind: 'empty' } : { kind: 'read', body: read.value }
  }

  /** Each write lands before `onOutcome`, so a hand-back is on disk before its label write starts. */
  async function settle(sessionKey: SessionKey, repoId: RepoId, runId: string, outcome: StageOutcome): Promise<void> {
    try {
      if (outcome.kind === 'questions' || outcome.kind === 'blocked') {
        // The session is still open — the run stays open.
        await runs.handback(repoId, runId, outcome)
        ctx.live.dispatcher.recordOutcome(repoId, sessionKey, outcome, null)
        return
      }

      if (outcome.kind === 'completed') {
        await ctx.live.hostedStore.close(sessionKey)
        const plan = await readPlanFile(sessionKey, outcome)
        const dismissResult = await ctx.live.hostedStore.dismiss(sessionKey, 'remove')
        const held = tracked.get(sessionKey)
        if (dismissResult.ok && held !== undefined && held.branch !== null) await releaseStageBranch(ctx, { root: held.root, branch: held.branch, baseSha: held.baseSha })
        const worktree = dismissResult.ok ? 'removed' : dismissResult.kind === 'worktree-dirty' ? 'kept-dirty' : dismissResult.kind === 'worktree-remove-failed' ? 'remove-failed' : outcome.worktree
        tracked.delete(sessionKey)
        const finished = { ...outcome, worktree }
        if (dismissResult.ok) await runs.ended(repoId, runId, finished)
        else await runs.interrupt(repoId, runId, { reason: 'cleanup-failed', detail: cleanupFailureDetail(dismissResult), resetsAt: null, costUsd: outcome.costUsd, outcome: finished })
        ctx.live.dispatcher.recordOutcome(repoId, sessionKey, finished, plan)
        return
      }

      // error, usage-limit, interrupted: close the session where needed, keep the worktree, and mark it.
      if (outcome.kind === 'error' || outcome.kind === 'usage-limit' || outcome.kind === 'interrupted') await ctx.live.hostedStore.close(sessionKey)
      tracked.delete(sessionKey)
      // `crash`/`quit` are reserved for a boot-time find and the quit path's own `quitAll`.
      const reason = outcome.kind === 'usage-limit' ? 'usage-limit' : outcome.kind === 'interrupted' && isTransientNetworkFailure(outcome.detail) ? 'network' : 'error'
      await runs.interrupt(repoId, runId, { reason, detail: outcome.detail, resetsAt: outcome.resetsAt, costUsd: outcome.costUsd, outcome })
      ctx.live.dispatcher.recordOutcome(repoId, sessionKey, outcome, null)
    } catch (error) {
      tracked.delete(sessionKey)
      const detail = `${SETTLE_FAILED_DETAIL}: ${error instanceof Error ? error.message : String(error)}`
      const failed: StageOutcome = { kind: 'error', detail, costUsd: outcome.costUsd, resetsAt: null, worktree: 'remove-failed', operatorJoined: outcome.operatorJoined, handback: null }
      await runs.interrupt(repoId, runId, { reason: 'error', detail, resetsAt: null, costUsd: outcome.costUsd, outcome: failed })
      ctx.live.dispatcher.recordOutcome(repoId, sessionKey, failed, null)
    }
  }

  return { launch, observe, resume }
}

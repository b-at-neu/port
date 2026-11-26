// Resume and Restart compositions for an interrupted stage session — operator-only, never called
// from the dispatch loop itself. Nothing here restarts anything on its own.
import { applyItemAction } from '@/main/pipeline/operator/apply'
import { readyEntryOf } from '@/main/pipeline/context'
import { releaseStageBranch } from '@/main/repos/worktree/stage-worktree'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import type { RecoverContext } from '@/main/dispatch/context'
import type { ResolvedStageRoot, StageResumeResult, StageRestartResult } from '@/types/stage'
import type { RepoId } from '@/utils/repos'

/** Sent after a resumed session's `init`. */
export const RESUME_PROMPT = 'You were interrupted. Continue your pipeline stage for #<n> from where you stopped.'

function freeSlotsOf(limit: number, open: number): number {
  return Math.max(0, limit - open)
}

async function readyRootOf(ctx: Pick<RecoverContext, 'repos'>, repoId: RepoId): Promise<ResolvedStageRoot | null> {
  const list = await ctx.repos.list()
  if (!list.ok) return null
  const entry = list.repositories.find((e) => e.id === repoId)
  return entry !== undefined && 'config' in entry ? { path: entry.path, sessionRequiredPaths: entry.config.sessionRequiredPaths } : null
}

/** The kept worktree, resumed through the launcher and sent `RESUME_PROMPT`. The launcher opens the run again in place. */
export async function resumeStage(ctx: RecoverContext, id: string): Promise<StageResumeResult> {
  const entry = ctx.stores.runs.list().find((e) => e.id === id)
  if (entry === undefined) return { kind: 'unknown-stage' }
  if (entry.claudeSessionId === null) return { kind: 'no-session-id' }

  const { limit } = await ctx.live.hostedStore.capacity()
  const open = ctx.live.hostedStore.list().filter((s) => s.phase !== 'ended').length
  if (freeSlotsOf(limit, open) <= 0) return { kind: 'at-capacity', limit }

  const root = await readyRootOf(ctx, entry.repoId)
  if (root === null) return { kind: 'start-failed', message: `repository ${entry.repoId} is no longer configured` }

  const result = await ctx.live.stageLauncher.resume({ entry, root, prompt: RESUME_PROMPT.replace('<n>', String(entry.number)) })
  if (result.ok) return { kind: 'ok', sessionKey: result.sessionKey }
  if (result.kind === 'at-capacity') return { kind: 'at-capacity', limit: result.limit }
  return { kind: 'start-failed', message: result.message }
}

/** Removes the kept worktree without force, applies the existing `retry` plan, then clears the run's interruption. Stops at the first failure; a dirty worktree never reaches the label step. */
export async function restartStage(ctx: RecoverContext, id: string): Promise<StageRestartResult> {
  const entry = ctx.stores.runs.list().find((e) => e.id === id)
  if (entry === undefined) return { kind: 'unknown-stage' }

  const removed = await removeSessionWorktreeAt(ctx, { path: entry.worktree.path, force: false })
  if (removed.outcome === 'dirty') return { kind: 'worktree-dirty' }
  if (removed.outcome === 'failed') return { kind: 'worktree-remove-failed', message: removed.message }

  const root = await readyRootOf(ctx, entry.repoId)
  if (entry.worktree.branch !== null && root !== null) await releaseStageBranch(ctx, { root: root.path, branch: entry.worktree.branch, baseSha: entry.worktree.baseSha })

  const ready = await readyEntryOf(ctx, "'stage:restart'", entry.repoId, (message) => `'stage:restart' could not list repositories: ${message}`)
  const retried = await applyItemAction(ctx, {
    request: { repoId: entry.repoId, kind: entry.kind, number: entry.number, action: 'retry', expected: { stage: entry.stage, status: { kind: 'running' } } },
    snapshot: ctx.live.watcher.snapshot(),
    entry: ready,
    auditDir: ctx.paths.userData,
  })
  if (!retried.ok) return { kind: 'label-refused', reason: retried.reason }

  await ctx.stores.runs.cleared(entry.repoId, id)
  return { kind: 'ok' }
}

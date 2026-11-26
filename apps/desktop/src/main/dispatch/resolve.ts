// The 'dispatch:control' action's composition — all the branching lives here, not in the action.
import { RUN_TARGET } from '@/types/dispatch'
import type { DispatchCommand, DispatchControlResult, TakeOwnershipResult } from '@/types/dispatch'
import type { RepoId } from '@/utils/repos'
import { isReadyEntry } from '@/main/repos'
import type { Repos } from '@/main/repos'
import { releaseOwnership, takeOwnership } from '@/main/repos/ownership'
import type { Platform } from '@/main/platform'
import type { HaltContext } from '@/main/dispatch/context'
import { haltDispatch } from '@/main/dispatch/halt'
import type { PipelineWatcher } from '@/types/state'

type ControlContext = HaltContext &
  Pick<Platform, 'git' | 'fs'> & {
    readonly repos: Pick<Repos, 'list'>
    readonly live: { readonly watcher: Pick<PipelineWatcher, 'snapshot' | 'refresh'> }
  }

/** Maps a failed `takeOwnership`/`releaseOwnership` write into the same reasons a run-state write failure carries. */
function ownershipWriteFailureReason(result: Extract<TakeOwnershipResult, { readonly ok: false }>): { readonly reason: 'ownership-unreadable' | 'unwritable'; readonly message: string; readonly path: string } {
  if (result.kind === 'refused') return { reason: 'ownership-unreadable', message: result.verdict.message, path: result.verdict.path }
  return { reason: 'unwritable', message: result.message, path: result.path }
}

/** Every command requires a registered `repoId`; `run`/`drain` take ownership and `pause` releases it. */
export async function resolveDispatchControl(ctx: ControlContext, request: { readonly command: DispatchCommand; readonly repoId: RepoId }): Promise<DispatchControlResult> {
  const { command, repoId } = request
  const list = await ctx.repos.list()
  if (!list.ok) throw new Error(`'dispatch:control' could not list repositories to validate '${repoId}'`)
  if (!list.repositories.some((r) => r.id === repoId)) throw new Error(`'dispatch:control' found no repository registered with id '${repoId}'`)
  const ready = list.repositories.filter(isReadyEntry).filter((e) => e.id === repoId)
  const { runStates } = ctx.stores

  if (command === 'run' || command === 'drain') {
    const [entry] = ready
    if (entry !== undefined) {
      const taken = await takeOwnership(ctx, { repoRoot: entry.path, repo: entry.config.repo })
      if (!taken.ok) return { ok: false, command, repoId, ...ownershipWriteFailureReason(taken) }
    }
    const written = await runStates.set([repoId], RUN_TARGET[command], ctx.clock.now().toISOString())
    if (command === 'run') {
      if (!written.ok) return { ok: false, command, repoId, reason: written.reason, message: written.message, path: runStates.path }
      await ctx.live.watcher.refresh({ repoId })
      return { ok: true, command, repoId, runState: runStates.current(repoId) }
    }
    if (!written.ok && written.reason === 'unreadable') return { ok: false, command, repoId, reason: 'unreadable', message: written.message, path: runStates.path }
    return { ok: true, command, repoId, runState: runStates.current(repoId), persisted: written.ok }
  }

  const report = await haltDispatch(ctx, { snapshot: ctx.live.watcher.snapshot(), entries: ready, repoIds: [repoId] })
  const released = (await Promise.all(ready.map((entry) => releaseOwnership(ctx, { repoRoot: entry.path, repo: entry.config.repo })))).every((r) => r.ok)
  await ctx.live.watcher.refresh({ repoId })
  return { ok: true, command: 'pause', repoId, runState: runStates.current(repoId), report, released }
}

// `held:force-dispatch` — the Needs-you "Dispatch anyway" write. Re-reads the watcher's latest
// snapshot and this repository's own dispatch status, never trusting what the renderer already saw.
import type { RepoId } from '@/utils/repos'
import type { HeldForceDispatchResult } from '@/types/dispatch'
import type { DispatchLive } from '@/main/dispatch/context'

export interface ForceDispatchContext {
  readonly live: {
    readonly dispatcher: Pick<DispatchLive['dispatcher'], 'status'>
    readonly watcher: Pick<DispatchLive['watcher'], 'snapshot' | 'republish'>
    readonly memos: Pick<DispatchLive['memos'], 'forceDispatch'>
  }
}

export function resolveForceDispatch(ctx: ForceDispatchContext, request: { readonly repoId: RepoId; readonly number: number }): HeldForceDispatchResult {
  const { repoId, number } = request
  const owner = ctx.live.dispatcher.status().find((s) => s.repoId === repoId)?.owner ?? 'none'
  if (owner !== 'app') return { kind: 'not-owned' }

  const report = ctx.live.watcher.snapshot().tick.find((t) => t.repoId === repoId)
  const held = report?.held.find((h) => h.number === number)
  if (held === undefined || held.reason !== 'contended') return { kind: 'not-held' }

  ctx.live.memos.forceDispatch.set(repoId, number)
  ctx.live.watcher.republish()
  return { kind: 'ok' }
}

// The third way a run leaves Needs you, after a `completed` hand-back and Restart: once per tick it clears
// interrupted entries whose ticket has moved on — only once their worktree is gone — then resumes usage-limit entries past their reset.
import type { BoardSnapshot } from '@/types/board'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { GitHubRepoRef } from '@/types/github'
import type { InterruptedStage, StageRestartResult, StageResumeResult } from '@/types/stage'
import { fetchItemsByNumber } from '@/main/github/tracker/items'
import { pathOps } from '@/main/platform/paths'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import type { SweepContext } from '@/main/dispatch/context'
import { restartStage, resumeStage } from '@/main/dispatch/stage/recover'
import { autoResumable, clearedByRecheck, networkGivenUp, orphanedRunning, staleInterrupted } from '@/main/dispatch/stage/stale'

interface InterruptedSweeper {
  /** Passes are serialized, and a failing one never stops the next. */
  consider(snapshot: BoardSnapshot, status: readonly RepoDispatchStatus[]): Promise<void>
}

function repoRefOf(slug: string): GitHubRepoRef | null {
  const [owner, name, ...rest] = slug.split('/')
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) return null
  return { owner, name }
}

function resumeFailure(result: Exclude<StageResumeResult, { readonly kind: 'ok' | 'at-capacity' }>): string {
  switch (result.kind) {
    case 'no-session-id':
      return 'the session ended before Claude started it'
    case 'start-failed':
      return result.message
    case 'unknown-stage':
      return 'it is no longer tracked'
  }
}

function restartFailure(result: Exclude<StageRestartResult, { readonly kind: 'ok' | 'worktree-dirty' }>): string {
  switch (result.kind) {
    case 'worktree-remove-failed':
      return result.message
    case 'label-refused':
      return result.reason
    case 'unknown-stage':
      return 'it is no longer tracked'
  }
}

export function createInterruptedSweeper(ctx: SweepContext): InterruptedSweeper {
  let chain: Promise<void> = Promise.resolve()
  const runs = ctx.stores.runs
  const liveWorktreePaths = (): readonly string[] => ctx.live.hostedStore.list().flatMap((snapshot) => (snapshot.phase !== 'ended' && snapshot.workspace.worktree !== null ? [snapshot.workspace.worktree.path] : []))

  // The entry may have been resumed while this pass awaited GitHub; a running session's worktree must never go.
  async function clearEntry(entry: InterruptedStage): Promise<boolean> {
    if (!runs.list().some((e) => e.id === entry.id)) return false
    const removed = (await ctx.fs.exists(entry.worktree.path)) ? await removeSessionWorktreeAt(ctx, { path: entry.worktree.path, force: false }) : null
    if (!runs.list().some((e) => e.id === entry.id)) return false
    if (removed === null || removed.outcome === 'removed') {
      await runs.cleared(entry.repoId, entry.id)
      return true
    }
    if (entry.reason === 'cleanup-failed') return false
    const detail = removed.outcome === 'dirty' ? 'it has uncommitted changes' : removed.message.trim()
    console.error(`[stage] could not remove ${entry.worktree.path}: ${detail}`)
    await runs.interrupt(entry.repoId, entry.id, { reason: 'cleanup-failed', detail, resetsAt: null, costUsd: entry.costUsd, outcome: null })
    return true
  }

  async function clearStale(snapshot: BoardSnapshot, status: readonly RepoDispatchStatus[]): Promise<boolean> {
    const interrupted = runs.list()
    let changed = false
    for (const repo of snapshot.state.repositories) {
      if (!repo.ok) continue
      const entries = interrupted.filter((e) => e.repoId === repo.repoId)
      if (entries.length === 0) continue

      const dispatch = status.find((s) => s.repoId === repo.repoId)
      const recent = dispatch?.state.kind === 'active' ? dispatch.state.recent : []
      const verdict = staleInterrupted({ entries, repo, recent })
      const ids = new Set(verdict.clear)

      const ref = repoRefOf(repo.repo)
      if (verdict.recheck.length > 0 && ref !== null) {
        const fetch = await fetchItemsByNumber(ctx, { repo: ref, numbers: verdict.recheck })
        for (const id of clearedByRecheck(entries.filter((e) => verdict.recheck.includes(e.number)), fetch)) ids.add(id)
      }

      for (const entry of entries.filter((e) => ids.has(e.id))) {
        if (await clearEntry(entry)) changed = true
      }
    }
    return changed
  }

  async function resumeDue(status: readonly RepoDispatchStatus[]): Promise<boolean> {
    let changed = false
    for (const id of autoResumable(runs.list(), ctx.clock.now(), status)) {
      const entry = runs.list().find((e) => e.id === id)
      if (entry === undefined) continue
      const result = await resumeStage(ctx, id)
      if (result.kind === 'ok') {
        changed = true
        continue
      }
      if (result.kind === 'at-capacity') break
      await runs.interrupt(entry.repoId, id, { reason: 'error', detail: `Couldn't resume after the usage limit reset: ${resumeFailure(result)}`, resetsAt: null, costUsd: entry.costUsd, outcome: null })
      changed = true
    }
    return changed
  }

  /** An open run no live session holds died without a hand-back; marking it makes it clearable and resumable. */
  async function markOrphans(): Promise<boolean> {
    const open = runs.running()
    const ids = orphanedRunning(open, liveWorktreePaths(), (a, b) => pathOps.samePath(a, b))
    for (const entry of open.filter((e) => ids.includes(e.id))) await runs.interrupt(entry.repoId, entry.id, { reason: 'crash', detail: 'the session ended without a hand-back', resetsAt: null, costUsd: null, outcome: null })
    return ids.length > 0
  }

  /** Restarts a network entry that used up its retries. Local work GitHub cannot see is a real decision, so a dirty worktree becomes an error entry. */
  async function restartGivenUp(status: readonly RepoDispatchStatus[]): Promise<boolean> {
    let changed = false
    for (const id of networkGivenUp(runs.list(), status)) {
      const entry = runs.list().find((e) => e.id === id)
      if (entry === undefined) continue
      const result = await restartStage(ctx, id)
      if (result.kind === 'ok') {
        changed = true
        continue
      }
      const detail = result.kind === 'worktree-dirty' ? 'the network stayed down after 3 retries, and its worktree has uncommitted changes' : `the network stayed down after 3 retries, and it could not be restarted: ${restartFailure(result)}`
      await runs.interrupt(entry.repoId, id, { reason: 'error', detail, resetsAt: null, costUsd: entry.costUsd, outcome: null })
      changed = true
    }
    return changed
  }

  async function pass(snapshot: BoardSnapshot, status: readonly RepoDispatchStatus[]): Promise<void> {
    try {
      const marked = await markOrphans()
      const cleared = await clearStale(snapshot, status)
      const resumed = await resumeDue(status)
      const restarted = await restartGivenUp(status)
      if (marked || cleared || resumed || restarted) ctx.live.watcher.republish()
    } catch (error) {
      console.error('[stage] the interrupted-entry sweep failed:', error)
    }
  }

  function consider(snapshot: BoardSnapshot, status: readonly RepoDispatchStatus[]): Promise<void> {
    chain = chain.then(() => pass(snapshot, status))
    return chain
  }

  return { consider }
}

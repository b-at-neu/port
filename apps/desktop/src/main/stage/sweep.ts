// The registry's third remover, after a `completed` hand-back and Restart: once per tick it clears
// interrupted entries whose ticket has moved on — only once their worktree is gone — then resumes usage-limit entries past their reset.
import type { BoardSnapshot } from '@/types/board'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { FetchItemsByNumberParams, GitHubRepoRef, ItemsByNumberFetch } from '@/types/github'
import type { InterruptedStage, StageRegistry, StageResumeResult } from '@/types/stage'
import type { RemoveSessionWorktreeOutcome } from '@/types/workspace'
import { autoResumable, clearedByRecheck, staleInterrupted } from '@/main/stage/stale'

interface CreateInterruptedSweeperParams {
  readonly registry: Pick<StageRegistry, 'list' | 'remove' | 'markInterrupted'>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly pathExists: (path: string) => Promise<boolean>
  readonly resume: (id: string) => Promise<StageResumeResult>
  /** Called once per pass that removed or changed anything, so the board republishes. */
  readonly onChange: () => void
  readonly now: () => Date
}

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

export function createInterruptedSweeper(params: CreateInterruptedSweeperParams): InterruptedSweeper {
  let chain: Promise<void> = Promise.resolve()

  // The entry may have been resumed while this pass awaited GitHub; a running session's worktree must never go.
  async function clearEntry(entry: InterruptedStage): Promise<boolean> {
    if (!params.registry.list().some((e) => e.id === entry.id)) return false
    const removed = (await params.pathExists(entry.worktree.path)) ? await params.removeWorktree(entry.worktree.path, false) : null
    if (!params.registry.list().some((e) => e.id === entry.id)) return false
    if (removed === null || removed.outcome === 'removed') {
      params.registry.remove(entry.id)
      return true
    }
    if (entry.reason === 'cleanup-failed') return false
    const detail = removed.outcome === 'dirty' ? 'it has uncommitted changes' : removed.message.trim()
    console.error(`[stage] could not remove ${entry.worktree.path}: ${detail}`)
    params.registry.markInterrupted(entry.id, 'cleanup-failed', detail, null, entry.costUsd)
    return true
  }

  async function clearStale(snapshot: BoardSnapshot, status: readonly RepoDispatchStatus[]): Promise<boolean> {
    const interrupted = params.registry.list()
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
        const fetch = await params.fetchItemsByNumber({ repo: ref, numbers: verdict.recheck })
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
    for (const id of autoResumable(params.registry.list(), params.now(), status)) {
      const entry = params.registry.list().find((e) => e.id === id)
      if (entry === undefined) continue
      const result = await params.resume(id)
      if (result.kind === 'ok') {
        changed = true
        continue
      }
      if (result.kind === 'at-capacity') break
      params.registry.markInterrupted(id, 'error', `Couldn't resume after the usage limit reset: ${resumeFailure(result)}`, null, entry.costUsd)
      changed = true
    }
    return changed
  }

  async function pass(snapshot: BoardSnapshot, status: readonly RepoDispatchStatus[]): Promise<void> {
    try {
      const cleared = await clearStale(snapshot, status)
      const resumed = await resumeDue(status)
      if (cleared || resumed) params.onChange()
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

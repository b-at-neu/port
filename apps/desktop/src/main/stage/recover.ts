// Resume and Restart compositions for an interrupted stage session — operator-only, never called
// from the dispatch loop itself. Nothing here restarts anything on its own.
import type { StageResumeResult, StageRestartResult } from '@/types/stage'

import type { RecoverDeps } from '@/types/stage'

/** Byte-identical restatement sent after a resumed session's `init` — the label swap already ran, so the resumed agent must never repeat its Pre-flight. */
export const RESUME_PROMPT = 'You were interrupted. Continue your pipeline stage for #<n> from where you stopped; your label swap has already happened.'

function freeSlotsOf(limit: number, open: number): number {
  return Math.max(0, limit - open)
}

/** `resumeStage(deps, id)` — the kept worktree, resumed through the launcher and sent `RESUME_PROMPT`. The launcher flips the registry entry back to `running` in place. */
export async function resumeStage(deps: RecoverDeps, id: string): Promise<StageResumeResult> {
  const entry = deps.registry.list().find((e) => e.id === id)
  if (entry === undefined) return { kind: 'unknown-stage' }
  if (entry.claudeSessionId === null) return { kind: 'no-session-id' }

  const { limit } = await deps.capacity()
  const open = deps.store.list().filter((s) => s.phase !== 'ended').length
  if (freeSlotsOf(limit, open) <= 0) return { kind: 'at-capacity', limit }

  const root = deps.resolveEntry(entry.repoId)
  if (root === null) return { kind: 'start-failed', message: `repository ${entry.repoId} is no longer configured` }

  const result = await deps.resume({ entry, root, prompt: RESUME_PROMPT.replace('<n>', String(entry.number)) })
  if (result.ok) return { kind: 'ok', sessionKey: result.sessionKey }
  if (result.kind === 'at-capacity') return { kind: 'at-capacity', limit: result.limit }
  return { kind: 'start-failed', message: result.message }
}

/** `restartStage(deps, id)` — removes the kept worktree without force, applies the existing `retry` plan, then removes the registry entry. Stops at the first failure; a dirty worktree never reaches the label step. */
export async function restartStage(deps: RecoverDeps, id: string): Promise<StageRestartResult> {
  const entry = deps.registry.list().find((e) => e.id === id)
  if (entry === undefined) return { kind: 'unknown-stage' }

  const removed = await deps.removeWorktree(entry.worktree.path, false)
  if (removed.outcome === 'dirty') return { kind: 'worktree-dirty' }
  if (removed.outcome === 'failed') return { kind: 'worktree-remove-failed', message: removed.message }

  const retried = await deps.applyRetry(entry)
  if (!retried.ok) return { kind: 'label-refused', reason: retried.reason }

  deps.registry.remove(id)
  return { kind: 'ok' }
}

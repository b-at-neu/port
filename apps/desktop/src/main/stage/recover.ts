// Resume and Restart compositions for an interrupted stage session — operator-only, never called
// from the dispatch loop itself. Nothing here restarts anything on its own.
import type { ItemActionResult } from '../../shared/actions/types'
import type { InterruptedStage, StageResumeResult, StageRestartResult } from '../../shared/stage/types'
import type { HostedStore } from '../hosting/store'
import type { RemoveSessionWorktreeOutcome } from '../workspace/worktree'
import type { StageRegistry } from './registry'
import { STAGE_AGENT_NAMES } from './agents'

/** Byte-identical restatement sent after a resumed session's `init` — the label swap already ran, so the resumed agent must never repeat its Pre-flight. */
export const RESUME_PROMPT = 'You were interrupted. Continue your pipeline stage for #<n> from where you stopped; your label swap has already happened.'

export interface ResolvedStageRoot {
  readonly path: string
  readonly sessionRequiredPaths: readonly string[]
}

export interface RecoverDeps {
  readonly registry: StageRegistry
  readonly store: Pick<HostedStore, 'start' | 'send' | 'close' | 'list'>
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly resolveEntry: (repoId: InterruptedStage['repoId']) => ResolvedStageRoot | null
  readonly applyRetry: (interrupted: InterruptedStage) => Promise<ItemActionResult>
  readonly capacity: () => Promise<{ readonly limit: number }>
}

function freeSlotsOf(limit: number, open: number): number {
  return Math.max(0, limit - open)
}

/** `resumeStage(deps, id)` — the kept worktree, resumed through `mode: 'resume'`, then sent `RESUME_PROMPT`. On `ok`, the registry entry flips back to `running`. */
export async function resumeStage(deps: RecoverDeps, id: string): Promise<StageResumeResult> {
  const entry = deps.registry.list().find((e) => e.id === id)
  if (entry === undefined) return { kind: 'unknown-stage' }
  if (entry.claudeSessionId === null) return { kind: 'no-session-id' }

  const { limit } = await deps.capacity()
  const open = deps.store.list().filter((s) => s.phase !== 'ended').length
  if (freeSlotsOf(limit, open) <= 0) return { kind: 'at-capacity', limit }

  const root = deps.resolveEntry(entry.repoId)
  if (root === null) return { kind: 'start-failed', message: `repository ${entry.repoId} is no longer configured` }

  const startResult = await deps.store.start({
    repoId: entry.repoId,
    mode: { kind: 'resume', sessionId: entry.claudeSessionId },
    workspace: {
      folder: entry.worktree.path,
      root: root.path,
      worktree: { path: entry.worktree.path, branch: entry.worktree.branch },
      base: { sha: entry.worktree.baseSha, label: entry.worktree.branch },
    },
    stage: {
      tag: { agent: entry.agent, number: entry.number, kind: entry.kind, trigger: entry.trigger },
      agentName: STAGE_AGENT_NAMES[entry.agent],
      model: entry.model,
      sessionRequiredPaths: root.sessionRequiredPaths,
    },
  })

  if (!startResult.ok) {
    if (startResult.kind === 'at-capacity') return { kind: 'at-capacity', limit: startResult.limit }
    return { kind: 'start-failed', message: startResult.kind }
  }

  const sessionKey = startResult.snapshot.sessionKey
  const sendResult = deps.store.send(sessionKey, RESUME_PROMPT.replace('<n>', String(entry.number)))
  if (!sendResult.ok) {
    await deps.store.close(sessionKey)
    return { kind: 'start-failed', message: `could not send the resume prompt: ${sendResult.kind}` }
  }

  deps.registry.recordRunning(entry)
  return { kind: 'ok', sessionKey }
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

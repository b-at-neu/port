// Pure classification of a stage session's final state into a StageOutcome — the hand-back contract's own decision logic, no I/O.
import type { SessionEnd, SessionRateLimit } from '@/types/hosting'
import type { SessionResult, StageOutcome } from '@/types/stage-session'
import type { SessionUsage } from '@/utils/hosting/usage'
import { classifyHandbackText } from '@/utils/stage/handback-text'

export interface ClassifyHandbackParams {
  readonly lastResult: SessionResult | null
  readonly end: SessionEnd | null
  readonly rateLimit: SessionRateLimit | null
  readonly usage: SessionUsage | null
  readonly phase: 'starting' | 'ready' | 'streaming' | 'interrupting' | 'closing' | 'ended'
  readonly operatorJoinedAt: string | null
}

/** `null` means still working — no outcome has been reached yet. */
export function classifyHandback(params: ClassifyHandbackParams): StageOutcome | null {
  const costUsd = params.usage?.costUsd ?? null
  const operatorJoined = params.operatorJoinedAt !== null

  if (params.phase !== 'ended' && params.lastResult === null) return null

  if (params.lastResult !== null && params.lastResult.isError) {
    if (params.rateLimit?.status === 'rejected') {
      return { kind: 'usage-limit', detail: null, costUsd, resetsAt: params.rateLimit.resetsAt, worktree: 'kept', operatorJoined }
    }
    const firstLine = params.lastResult.text?.split('\n')[0] ?? null
    const detail = firstLine === null ? params.lastResult.subtype : `${params.lastResult.subtype}: ${firstLine}`
    return { kind: 'error', detail, costUsd, resetsAt: null, worktree: 'kept', operatorJoined }
  }

  if (params.lastResult !== null) {
    const text = params.lastResult.text ?? ''
    const handback = classifyHandbackText(text)
    if (handback?.kind === 'questions') {
      return { kind: 'questions', detail: null, costUsd, resetsAt: null, worktree: 'kept', operatorJoined }
    }
    if (handback?.kind === 'blocked') {
      return { kind: 'blocked', detail: handback.line, costUsd, resetsAt: null, worktree: 'kept', operatorJoined }
    }
    return { kind: 'completed', detail: null, costUsd, resetsAt: null, worktree: 'removed', operatorJoined }
  }

  // phase === 'ended' with no lastResult at all.
  return { kind: 'interrupted', detail: params.end?.reason ?? null, costUsd, resetsAt: null, worktree: 'kept', operatorJoined }
}

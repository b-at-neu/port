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

const TRANSIENT_NETWORK = /EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|Can't reach the API server/i

/** Whether an error text names a network failure a later attempt can clear. */
/** What a settle that threw reports as its detail, ahead of the error's own message. */
export const SETTLE_FAILED_DETAIL = 'hand-back settle failed'

export function isTransientNetworkFailure(text: string | null | undefined): boolean {
  return TRANSIENT_NETWORK.test(text ?? '')
}

/** `null` means still working — no outcome has been reached yet. */
export function classifyHandback(params: ClassifyHandbackParams): StageOutcome | null {
  const costUsd = params.usage?.costUsd ?? null
  const operatorJoined = params.operatorJoinedAt !== null

  if (params.phase !== 'ended' && params.lastResult === null) return null

  if (params.lastResult !== null && params.lastResult.isError) {
    if (params.rateLimit?.status === 'rejected') {
      return { kind: 'usage-limit', detail: null, costUsd, resetsAt: params.rateLimit.resetsAt, worktree: 'kept', operatorJoined, handback: null }
    }
    const firstLine = params.lastResult.text?.split('\n')[0] ?? null
    const detail = firstLine === null ? params.lastResult.subtype : `${params.lastResult.subtype}: ${firstLine}`
    if (isTransientNetworkFailure(firstLine)) return { kind: 'interrupted', detail, costUsd, resetsAt: null, worktree: 'kept', operatorJoined, handback: null }
    return { kind: 'error', detail, costUsd, resetsAt: null, worktree: 'kept', operatorJoined, handback: null }
  }

  if (params.lastResult !== null) {
    const text = params.lastResult.text ?? ''
    const parsed = classifyHandbackText(text)
    if (parsed?.kind === 'questions') {
      return { kind: 'questions', detail: null, costUsd, resetsAt: null, worktree: 'kept', operatorJoined, handback: null }
    }
    if (parsed?.kind === 'blocked') {
      return { kind: 'blocked', detail: parsed.line, costUsd, resetsAt: null, worktree: 'kept', operatorJoined, handback: null }
    }
    const handback = parsed?.kind === 'handback' ? { token: parsed.token, arg: parsed.arg } : null
    return { kind: 'completed', detail: null, costUsd, resetsAt: null, worktree: 'removed', operatorJoined, handback }
  }

  // phase === 'ended' with no lastResult at all.
  return { kind: 'interrupted', detail: params.end?.reason ?? null, costUsd, resetsAt: null, worktree: 'kept', operatorJoined, handback: null }
}

// Pure classification of a stage session's final state into a StageOutcome — the hand-back contract's own decision logic, no I/O.
import type { SessionEnd, SessionRateLimit } from '../../shared/hosting/types'
import type { SessionResult, StageOutcome } from '../../shared/hosting/stage'
import type { SessionUsage } from '../../shared/hosting/usage'

/** Pinned byte-identical to `plugins/port/skills/pipeline/SKILL.md`'s own completion-handling prefixes, by the `desktop-dispatch` check. */
export const QUESTIONS_PREFIX = 'QUESTIONS FOR HUMAN:'
export const BLOCKED_PREFIX = 'BLOCKED:'

export interface ClassifyHandbackParams {
  readonly lastResult: SessionResult | null
  readonly end: SessionEnd | null
  readonly rateLimit: SessionRateLimit | null
  readonly usage: SessionUsage | null
  readonly phase: 'starting' | 'ready' | 'streaming' | 'interrupting' | 'closing' | 'ended'
}

/** The text's last non-blank paragraph — paragraphs split on a blank line, since the prefix sits at the very end of the final message. */
function lastParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim())
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]
    if (p !== undefined && p !== '') return p
  }
  return ''
}

/** A `BLOCKED:` line at line start, outside a fenced code block — a block is any line pair of ``` markers, closed or not. */
function blockedLineOutsideFence(text: string): string | null {
  const lines = text.split('\n')
  let inFence = false
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence
      continue
    }
    if (!inFence && line.startsWith(BLOCKED_PREFIX)) return line
  }
  return null
}

/** `null` means still working — no outcome has been reached yet. */
export function classifyHandback(params: ClassifyHandbackParams): StageOutcome | null {
  const costUsd = params.usage?.costUsd ?? null

  if (params.phase !== 'ended' && params.lastResult === null) return null

  if (params.lastResult !== null && params.lastResult.isError) {
    if (params.rateLimit?.status === 'rejected') {
      return { kind: 'usage-limit', detail: null, costUsd, resetsAt: params.rateLimit.resetsAt, worktree: 'kept' }
    }
    const firstLine = params.lastResult.text?.split('\n')[0] ?? null
    const detail = firstLine === null ? params.lastResult.subtype : `${params.lastResult.subtype}: ${firstLine}`
    return { kind: 'error', detail, costUsd, resetsAt: null, worktree: 'kept' }
  }

  if (params.lastResult !== null) {
    const text = params.lastResult.text ?? ''
    const paragraph = lastParagraph(text)
    if (paragraph.startsWith(QUESTIONS_PREFIX)) {
      return { kind: 'questions', detail: null, costUsd, resetsAt: null, worktree: 'kept' }
    }
    const blocked = blockedLineOutsideFence(text)
    if (blocked !== null) {
      return { kind: 'blocked', detail: blocked, costUsd, resetsAt: null, worktree: 'kept' }
    }
    return { kind: 'completed', detail: null, costUsd, resetsAt: null, worktree: 'removed' }
  }

  // phase === 'ended' with no lastResult at all.
  return { kind: 'interrupted', detail: params.end?.reason ?? null, costUsd, resetsAt: null, worktree: 'kept' }
}

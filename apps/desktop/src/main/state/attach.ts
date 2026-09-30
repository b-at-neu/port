// The agent, session, and worktree attachment ladders (#79 Decision 3), plus
// the orphan-number collector (Decision 4) — pure, no I/O.
import type { AgentRecord, SessionRecord } from '../../shared/sessions/types'
import type { WorktreeEntry } from '../../shared/local/types'
import type { AttachedAgent, AttachedSession, AttachedWorktree } from '../../shared/state/types'

export interface AttachTarget {
  readonly number: number
  /** This item's linked counterpart (issue ↔ pull request), or `null` — the
   *  `match: 'linked'` rung is how a `review #<pr>` dispatch, whose
   *  `itemNumber` names the pull request, attaches to the issue instead. */
  readonly linked: number | null
}

/** Direct number match first, then the linked counterpart — an agent record
 *  with `itemNumber: null` (a non-port agent like `Explore`) attaches to
 *  nothing. */
export function attachAgents(item: AttachTarget, agents: readonly AgentRecord[]): readonly AttachedAgent[] {
  const attached: AttachedAgent[] = []
  for (const agent of agents) {
    if (agent.itemNumber === null) continue
    const match = agent.itemNumber === item.number ? 'direct' : item.linked !== null && agent.itemNumber === item.linked ? 'linked' : null
    if (match === null) continue
    attached.push({
      agentId: agent.agentId,
      agentType: agent.agentType,
      stage: agent.stage,
      model: agent.model,
      activity: agent.activity,
      idleMs: agent.idleMs,
      lastActivityAt: agent.lastActivityAt,
      match,
    })
  }
  return attached
}

/** The same ladder as `attachAgents`, over `SessionRecord`s instead — a
 *  `SESSION REQUIRED` ticket's `/port:implement` session carries
 *  `role: 'implement'` and its own `itemNumber` (from the `impl-<n>`
 *  worktree name), and matches here even though it spawns no subagent. */
export function attachSessions(item: AttachTarget, sessions: readonly SessionRecord[]): readonly AttachedSession[] {
  const attached: AttachedSession[] = []
  for (const session of sessions) {
    if (session.itemNumber === null) continue
    const match = session.itemNumber === item.number ? 'direct' : item.linked !== null && session.itemNumber === item.linked ? 'linked' : null
    if (match === null) continue
    attached.push({
      sessionId: session.sessionId,
      role: session.role,
      roleEvidence: session.roleEvidence,
      activity: session.activity,
      idleMs: session.idleMs,
      lastActivityAt: session.lastActivityAt,
      match,
    })
  }
  return attached
}

/** A worktree whose `unresolved` is set never attaches to anything here — it
 *  goes to the repository-level `uncorrelatedWorktrees` instead, with its
 *  reason intact (`reconcile.ts`'s job, not this ladder's). */
export function attachWorktrees(item: AttachTarget, worktrees: readonly WorktreeEntry[]): readonly AttachedWorktree[] {
  const attached: AttachedWorktree[] = []
  for (const worktree of worktrees) {
    if (worktree.correlation === null) continue
    if (worktree.correlation.number !== item.number) continue
    attached.push({
      path: worktree.path,
      branch: worktree.branch,
      producer: worktree.producer,
      rung: worktree.correlation.rung,
      locked: worktree.locked,
      prunable: worktree.prunable,
    })
  }
  return attached
}

/**
 * Every number a worktree's correlation or an agent record's `itemNumber`
 * names, absent from the open sweep's own item numbers — the deduplicated
 * re-check set `fetchItemsByNumber` (#79 Decision 4) resolves. `#0` is
 * already excluded at both sources (`correlate.ts`, `itemNumberOf`), so it
 * never reaches here.
 */
export function collectOrphanNumbers(
  items: readonly { readonly number: number }[],
  worktrees: readonly WorktreeEntry[],
  agents: readonly AgentRecord[],
): readonly number[] {
  const known = new Set(items.map((item) => item.number))
  const orphans = new Set<number>()
  for (const worktree of worktrees) {
    const number = worktree.correlation?.number
    if (number !== undefined && !known.has(number)) orphans.add(number)
  }
  for (const agent of agents) {
    if (agent.itemNumber !== null && !known.has(agent.itemNumber)) orphans.add(agent.itemNumber)
  }
  return [...orphans]
}

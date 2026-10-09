// The agent, session, and worktree attachment ladders, plus the orphan-number collector — pure, no I/O.
import type { AgentRecord, SessionRecord } from '../../shared/sessions/types'
import type { WorktreeEntry } from '../../shared/local/types'
import type { AttachedAgent, AttachedSession, AttachedWorktree } from '../../shared/state/types'

export interface AttachTarget {
  readonly number: number
  /** This item's linked counterpart (issue ↔ pull request), or `null` — how a `review #<pr>` dispatch attaches to the issue instead. */
  readonly linked: number | null
}

/** Direct number match first, then the linked counterpart — an agent with `itemNumber: null` attaches to nothing. */
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

/** The same ladder as `attachAgents`, over `SessionRecord`s — an `/port:implement` session matches even though it spawns no subagent. */
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

/** A worktree with no correlation never attaches here — it goes to `uncorrelatedWorktrees` instead, which is `reconcile.ts`'s job. */
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

/** Every number a worktree's correlation or an agent's `itemNumber` names, absent from the open sweep's own item numbers. `#0` is excluded at both sources, so it never reaches here. */
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

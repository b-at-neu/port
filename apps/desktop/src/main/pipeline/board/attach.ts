// The agent, session, and worktree attachment ladders, plus the orphan-number collector — pure, no I/O.
import type { AgentRecord, SessionRecord } from '@/types/sessions'
import type { WorktreeEntry } from '@/types/local'
import type { PipelineItemKind } from '@/types/github'
import type { AttachedAgent, AttachedSession, AttachedWorktree, WorkSession } from '@/types/state'
import type { PathOps, RepoKey } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'

interface AttachTarget {
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
      sessionId: agent.sessionId,
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

const TICKET_TITLE = /^(PR)?#([1-9]\d*)(?: |$)/

interface IndexedSession {
  readonly record: SessionRecord
  readonly worktreeNumbers: ReadonlySet<number>
  readonly branchNumbers: ReadonlySet<number>
  readonly title: { readonly kind: PipelineItemKind; readonly number: number } | null
}

interface WorkSessionIndex {
  readonly sessions: readonly IndexedSession[]
  readonly byNumber: ReadonlyMap<number, readonly number[]>
}

const NO_NUMBERS: ReadonlySet<number> = new Set()

function keyOf(ops: PathOps, path: string): RepoKey | null {
  try {
    return ops.pathKey(path)
  } catch {
    return null
  }
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key)
  if (set === undefined) map.set(key, new Set([value]))
  else set.add(value)
}

/** The numbers of the deepest worktree whose path is `cwd` or an ancestor of it, found by walking up `cwd` rather than scanning every worktree. */
function ownerNumbersOf(ops: PathOps, cwd: string | null, owners: ReadonlyMap<RepoKey, ReadonlySet<number>>): ReadonlySet<number> {
  if (cwd === null) return NO_NUMBERS
  let key = keyOf(ops, cwd)
  while (key !== null) {
    const found = owners.get(key)
    if (found !== undefined) return found
    const parent = ops.dirname(key)
    if (parent === key) return NO_NUMBERS
    key = ops.pathKey(parent)
  }
  return NO_NUMBERS
}

/** Built once per reconcile pass: each session's owning worktree is resolved once, so a lookup per item never rescans sessions or worktrees. Cockpit sessions never count. */
export function indexWorkSessions(sessions: readonly SessionRecord[], worktrees: readonly WorktreeEntry[], ops: PathOps = pathOps): WorkSessionIndex {
  const owners = new Map<RepoKey, Set<number>>()
  const branches = new Map<string, Set<number>>()
  for (const worktree of worktrees) {
    const key = keyOf(ops, worktree.path)
    if (key === null) continue
    const numbers = owners.get(key) ?? new Set<number>()
    owners.set(key, numbers)
    if (worktree.correlation === null) continue
    numbers.add(worktree.correlation.number)
    if (worktree.branch !== null) addTo(branches, worktree.branch, worktree.correlation.number)
  }

  const indexed: IndexedSession[] = []
  const byNumber = new Map<number, number[]>()
  for (const record of sessions) {
    if (record.role === 'cockpit') continue
    const worktreeNumbers = ownerNumbersOf(ops, record.cwd, owners)
    const branchNumbers = record.gitBranch === null ? NO_NUMBERS : (branches.get(record.gitBranch) ?? NO_NUMBERS)
    const parsed = record.customTitle === null ? null : TICKET_TITLE.exec(record.customTitle)
    const title = parsed === null ? null : { kind: parsed[1] === undefined ? ('issue' as const) : ('pull-request' as const), number: Number(parsed[2]) }
    const position = indexed.length
    indexed.push({ record, worktreeNumbers, branchNumbers, title })
    const hits = new Set([...worktreeNumbers, ...branchNumbers, ...(title === null ? [] : [title.number])])
    for (const number of hits) {
      const list = byNumber.get(number)
      if (list === undefined) byNumber.set(number, [position])
      else list.push(position)
    }
  }
  return { sessions: indexed, byNumber }
}

/** First hit wins per session: the most specific worktree its cwd sits in, its git branch, then a title naming this ticket — never a branch-name pattern. */
export function workSessionsFor(index: WorkSessionIndex, item: { readonly number: number; readonly kind: PipelineItemKind }): readonly WorkSession[] {
  const attached: WorkSession[] = []
  for (const position of index.byNumber.get(item.number) ?? []) {
    const session = index.sessions[position]
    if (session === undefined) continue
    const match: WorkSession['match'] | null = session.worktreeNumbers.has(item.number)
      ? 'worktree'
      : session.branchNumbers.has(item.number)
        ? 'branch'
        : session.title !== null && session.title.kind === item.kind && session.title.number === item.number
          ? 'title'
          : null
    if (match === null) continue
    const { record } = session
    attached.push({ sessionId: record.sessionId, title: record.customTitle, lastActivityAt: record.lastActivityAt, activity: record.activity, match })
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

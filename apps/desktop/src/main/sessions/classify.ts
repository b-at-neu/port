// Pure, I/O-free classification (#78): attribution, role, stage, item
// number, and activity. Nothing here touches the filesystem or the SDK —
// `adapter.ts` is the only orchestration layer, so every rule below is
// testable without a real transcript on disk.
import { pathOps } from '../platform'
import type { RepoId } from '../../shared/repos'
import { ACTIVE_WITHIN_MS, IDLE_WITHIN_MS } from '../../shared/sessions/types'
import type { Activity, PortStageAgent, RoleEvidence, SessionRole } from '../../shared/sessions/types'

/** The four port pipeline stage agents — the one place this union is
 *  declared; `classify.test.ts` and the `desktop-sessions` layer 1 check
 *  both pin it against `plugins/port/agents/`'s real basenames. */
export const PORT_STAGE_AGENTS: readonly PortStageAgent[] = ['plan-agent', 'impl-agent', 'review-agent', 'revise-agent']

/** The repository reference this adapter takes from its caller — #74's
 *  `RepositoryEntry` narrowed to exactly what attribution needs. This
 *  adapter reads no config and enumerates no worktrees; `root` is supplied
 *  by the caller, never derived here. */
export interface RepoRef {
  readonly id: RepoId
  readonly root: string
}

export interface Attribution {
  readonly repoId: RepoId | null
  readonly worktreePath: string | null
}

/** `pathOps.contains`/`samePath` only — never `startsWith`, which would
 *  match a sibling directory sharing a name prefix (`port` vs `portfolio`). */
export function attributeSession(repos: readonly RepoRef[], cwd: string | null): Attribution {
  if (cwd === null) return { repoId: null, worktreePath: null }
  for (const repo of repos) {
    if (!pathOps.samePath(repo.root, cwd) && !pathOps.contains(repo.root, cwd)) continue
    const worktreesRoot = pathOps.join(repo.root, '.claude', 'worktrees')
    const worktreePath = pathOps.samePath(worktreesRoot, cwd) || pathOps.contains(worktreesRoot, cwd) ? cwd : null
    return { repoId: repo.id, worktreePath }
  }
  return { repoId: null, worktreePath: null }
}

function basenameOf(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? ''
}

/** True when `path`'s immediate parent is `.claude/worktrees` (either
 *  separator), so rung 1 of the role ladder does not fire on an unrelated
 *  directory that merely happens to be named `impl-<n>`. */
function isUnderClaudeWorktrees(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '')
  const len = segments.length
  return len >= 3 && segments[len - 2] === 'worktrees' && segments[len - 3] === '.claude'
}

const IMPL_WORKTREE_DIRNAME = /^impl-(\d+)$/
const FIRST_PROMPT_COMMAND = /^\/[A-Za-z0-9_-]+:(pipeline|implement)(?![\w-])/

export interface RoleInput {
  readonly cwd: string | null
  readonly firstPrompt: string | null
}

export interface RoleVerdict {
  readonly role: SessionRole
  readonly evidence: RoleEvidence | null
  readonly itemNumber: number | null
}

/**
 * `SessionRole`'s ladder, first hit wins, structural evidence before
 * heuristic:
 *
 * 1. `cwd` basename matches `^impl-(\d+)$` directly under `.claude/worktrees`
 *    → `implement`, `worktree-name`, the captured number is `itemNumber`.
 * 2. At least one of `agentTypes` resolves to a port stage agent (via
 *    `stageOf`) → `cockpit`, `stage-agent`.
 * 3. `firstPrompt` matches `^/<prefix>:(pipeline|implement)` as a whole word
 *    (not followed by `[\w-]`, so `pipeline-old` does not match) — the prefix
 *    is a wildcard, never the literal `port`, since an adopter installs the
 *    plugin under whatever name they chose → `cockpit`/`implement`,
 *    `first-prompt`.
 * 4. Otherwise `other`, no evidence.
 */
export function sessionRole(session: RoleInput, agentTypes: readonly string[]): RoleVerdict {
  if (session.cwd !== null) {
    const match = IMPL_WORKTREE_DIRNAME.exec(basenameOf(session.cwd))
    if (match?.[1] !== undefined && isUnderClaudeWorktrees(session.cwd)) {
      return { role: 'implement', evidence: 'worktree-name', itemNumber: Number(match[1]) }
    }
  }

  if (agentTypes.some((agentType) => stageOf(agentType) !== null)) {
    return { role: 'cockpit', evidence: 'stage-agent', itemNumber: null }
  }

  if (session.firstPrompt !== null) {
    const match = FIRST_PROMPT_COMMAND.exec(session.firstPrompt)
    if (match?.[1] !== undefined) {
      return { role: match[1] === 'implement' ? 'implement' : 'cockpit', evidence: 'first-prompt', itemNumber: null }
    }
  }

  return { role: 'other', evidence: null, itemNumber: null }
}

/** Matched prefix-agnostically: everything up to and including the last `:`
 *  is stripped before matching, since real records on this machine carry
 *  both `"port:plan-agent"` and a bare `"plan-agent"`. `null` for a non-port
 *  agent (`Explore`, `general-purpose`). */
export function stageOf(agentType: string): PortStageAgent | null {
  const colonIndex = agentType.lastIndexOf(':')
  const bare = colonIndex === -1 ? agentType : agentType.slice(colonIndex + 1)
  return (PORT_STAGE_AGENTS as readonly string[]).includes(bare) ? (bare as PortStageAgent) : null
}

/** `/#(\d+)\b/`, first match, `#0` excluded — the same rule as
 *  `PIPELINE.md`'s worktree correlation ladder. The stage word itself is
 *  never parsed; only the number is. */
export function itemNumberOf(description: string | null): number | null {
  if (description === null) return null
  const match = /#(\d+)\b/.exec(description)
  const raw = match?.[1]
  if (raw === undefined) return null
  const parsed = Number(raw)
  return parsed === 0 ? null : parsed
}

export interface ActivityResult {
  readonly idleMs: number
  readonly activity: Activity
}

/** Recency, never liveness (Decision 4) — the two exported thresholds are
 *  the single definition `#79` and every test share. */
export function activityOf(modifiedAt: string, now: Date): ActivityResult {
  const idleMs = Math.max(0, now.getTime() - new Date(modifiedAt).getTime())
  const activity: Activity = idleMs <= ACTIVE_WITHIN_MS ? 'active' : idleMs <= IDLE_WITHIN_MS ? 'idle' : 'dormant'
  return { idleMs, activity }
}

export interface ParsedAgentMeta {
  readonly agentType: string
  readonly description: string | null
  readonly model: string | null
  readonly worktreePath: string | null
  readonly worktreeBranch: string | null
  readonly spawnDepth: number | null
}

export type ParseAgentMetaResult = { readonly ok: true; readonly value: ParsedAgentMeta } | { readonly ok: false; readonly message: string }

/** Never throws on a shape it did not expect — a record or a reported
 *  reason, matched by the caller into a `MetaProblem` with the file's own
 *  `sessionId`/`agentId` context, which this pure function does not have. */
export function parseAgentMeta(raw: unknown): ParseAgentMetaResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'meta.json is not an object' }
  }
  const record = raw as Record<string, unknown>
  const agentType = record.agentType
  if (typeof agentType !== 'string' || agentType === '') {
    return { ok: false, message: 'meta.json is missing a non-empty agentType' }
  }
  const description = record.description
  const model = record.model
  const worktreePath = record.worktreePath
  const worktreeBranch = record.worktreeBranch
  const spawnDepth = record.spawnDepth
  return {
    ok: true,
    value: {
      agentType,
      description: typeof description === 'string' ? description : null,
      model: typeof model === 'string' ? model : null,
      worktreePath: typeof worktreePath === 'string' ? worktreePath : null,
      worktreeBranch: typeof worktreeBranch === 'string' ? worktreeBranch : null,
      spawnDepth: typeof spawnDepth === 'number' ? spawnDepth : null,
    },
  }
}

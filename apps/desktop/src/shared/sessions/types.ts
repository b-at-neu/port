// Renderer-safe session and agent shapes for the local session adapter. No import here may reach a Node builtin or the Agent SDK — only `main/sessions/` touches either.
import type { RepoId } from '../repos'

/** The four port pipeline stage agents, pinned against the real basenames under `plugins/port/agents/`, both directions. */
export type PortStageAgent = 'plan-agent' | 'impl-agent' | 'review-agent' | 'revise-agent'

export type SessionRole = 'cockpit' | 'implement' | 'other'

/** Which rung of the role ladder produced the verdict — the heuristic rung (`first-prompt`) stays visibly a heuristic, not indistinguishable from the structural ones ahead of it. */
export type RoleEvidence = 'worktree-name' | 'stage-agent' | 'first-prompt'

/** Recency, never liveness. A crashed agent's transcript file looks identical to a live one's, only older — no identifier here may say `running`, `alive`, or `isLive`. */
export type Activity = 'active' | 'idle' | 'dormant'

/** Idle within five minutes reads as `active`. */
export const ACTIVE_WITHIN_MS = 5 * 60 * 1000
/** Idle within an hour reads as `idle`; beyond it, `dormant`. Shared rather than each caller carrying its own threshold. */
export const IDLE_WITHIN_MS = 60 * 60 * 1000

/** A session the SDK reported but whose directory the locate ladder could not resolve — named here, never silently dropped. */
export interface SessionRef {
  readonly sessionId: string
}

export interface SessionRecord {
  readonly sessionId: string
  /** `null` **is** the unattributed case — a session in a project this caller never registered. Counted in `SessionScan.unattributed`, never dropped. */
  readonly repoId: RepoId | null
  readonly cwd: string | null
  /** Set when `cwd` sits under `<root>/.claude/worktrees/` — the session's own location, not an enumeration of worktrees. */
  readonly worktreePath: string | null
  readonly role: SessionRole
  readonly roleEvidence: RoleEvidence | null
  readonly itemNumber: number | null
  readonly customTitle: string | null
  readonly summary: string | null
  readonly firstPrompt: string | null
  readonly gitBranch: string | null
  readonly lastActivityAt: string
  readonly idleMs: number
  readonly activity: Activity
  readonly agentIds: readonly string[]
}

export interface AgentRecord {
  readonly sessionId: string
  readonly repoId: RepoId | null
  readonly agentId: string
  /** Matched prefix-agnostically elsewhere — real records carry both `"port:plan-agent"` and a bare `"plan-agent"`. Carried here verbatim. */
  readonly agentType: string
  /** `null` for a non-port agent — kept and reported, never filtered out. */
  readonly stage: PortStageAgent | null
  readonly model: string | null
  readonly description: string | null
  /** Parsed from `description` only, as `/#(\d+)\b/`, first match, `#0` excluded. */
  readonly itemNumber: number | null
  readonly worktreePath: string | null
  readonly worktreeBranch: string | null
  readonly spawnDepth: number | null
  readonly lastActivityAt: string
  readonly idleMs: number
  readonly activity: Activity
}

/** The subset of `FileFailureKind` that reaches a `meta.json` read, plus `malformed` for a file that parsed as JSON but carried no usable `agentType`. Redeclared, since this file may import nothing from `src/main/`. */
export type MetaProblemKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io' | 'malformed'

/** Why one `agent-<id>.meta.json` never became an `AgentRecord` — a single malformed file never drops the rest of the scan. */
export interface MetaProblem {
  readonly sessionId: string
  readonly agentId: string
  readonly kind: MetaProblemKind
  readonly message: string
}

export type SessionFailureKind = 'sdk-unavailable' | 'sdk-failed' | 'claude-home-missing' | 'projects-unreadable'

/** Fails closed on the answer, open on reporting. No path returns `sessions: []` for a scan that did not succeed; a partial scan returns `ok: true` with real data alongside the named gaps. */
export type SessionScan =
  | {
      readonly ok: true
      readonly sessions: readonly SessionRecord[]
      readonly agents: readonly AgentRecord[]
      readonly unattributed: number
      readonly unresolved: readonly SessionRef[]
      readonly unreadable: readonly MetaProblem[]
      readonly scannedProjects: number
      readonly scanMs: number
      readonly scannedAt: string
    }
  | {
      readonly ok: false
      readonly kind: SessionFailureKind
      readonly message: string
      readonly scannedAt: string
    }

// Renderer-safe session and agent shapes for the local session adapter
// (#78). No import here may reach a Node builtin or the Agent SDK —
// apps/desktop/src/main/sessions/ is the only place that touches either, but
// the renderer is the eventual consumer of these shapes over IPC (#79/#80),
// so this file compiles under `typecheck:web` too.
import type { RepoId } from '../repos'

/** The four port pipeline stage agents. Pinned against the real basenames
 *  under `plugins/port/agents/`, both directions, by the `desktop-sessions`
 *  layer 1 check — a second transcription of the agent list gets a
 *  mechanical pin, never a comment (ENGINEERING §2). */
export type PortStageAgent = 'plan-agent' | 'impl-agent' | 'review-agent' | 'revise-agent'

export type SessionRole = 'cockpit' | 'implement' | 'other'

/** Which rung of the role ladder produced the verdict — carried so a
 *  classification is auditable rather than opaque, and so the heuristic rung
 *  (`first-prompt`) is visibly a heuristic rather than indistinguishable
 *  from the structural ones ahead of it. */
export type RoleEvidence = 'worktree-name' | 'stage-agent' | 'first-prompt'

/** Recency, never liveness (Decision 4). Nothing readable from a local
 *  transcript proves a process is running — a crashed agent's file looks
 *  identical to a live one's, only older. Deciding whether an item is
 *  stalled is #79's job, from these facts plus the labels; no identifier or
 *  string in this tree may say `running`, `alive`, or `isLive`. */
export type Activity = 'active' | 'idle' | 'dormant'

/** Idle within five minutes reads as `active`. */
export const ACTIVE_WITHIN_MS = 5 * 60 * 1000
/** Idle within an hour reads as `idle`; beyond it, `dormant`. #79 and every
 *  test share these two constants rather than each carrying its own
 *  threshold. */
export const IDLE_WITHIN_MS = 60 * 60 * 1000

/** A session the SDK reported but whose directory the locate ladder could
 *  not resolve — named here, never silently dropped or returned with
 *  `agents: []` (ENGINEERING §4: an absent signal is never read as a
 *  passing one). */
export interface SessionRef {
  readonly sessionId: string
}

export interface SessionRecord {
  readonly sessionId: string
  /** `null` **is** the unattributed case — a session in a project this
   *  caller never registered. Counted in `SessionScan.unattributed` and
   *  never dropped. */
  readonly repoId: RepoId | null
  readonly cwd: string | null
  /** Set when `cwd` sits under `<root>/.claude/worktrees/` — the session's
   *  own location, not an enumeration of worktrees (that is #77's). */
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
  /** Matched prefix-agnostically elsewhere (`stageOf`) — real records carry
   *  both `"port:plan-agent"` and a bare `"plan-agent"`. Carried here
   *  verbatim so the raw value is never lost. */
  readonly agentType: string
  /** `null` for a non-port agent (`Explore`, `general-purpose`) — kept and
   *  reported, never filtered out. */
  readonly stage: PortStageAgent | null
  readonly model: string | null
  readonly description: string | null
  /** Parsed from `description` only, as `/#(\d+)\b/`, first match, `#0`
   *  excluded — the same rule as `PIPELINE.md`'s worktree correlation
   *  ladder. */
  readonly itemNumber: number | null
  readonly worktreePath: string | null
  readonly worktreeBranch: string | null
  readonly spawnDepth: number | null
  readonly lastActivityAt: string
  readonly idleMs: number
  readonly activity: Activity
}

/** The subset of `FileFailureKind` (`main/platform/files.ts`) that reaches a
 *  `meta.json` read, plus `malformed` for a file that parsed as JSON but
 *  carried no usable `agentType`. Redeclared rather than imported: this file
 *  may import nothing from `src/main/`. */
export type MetaProblemKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'unparseable' | 'io' | 'malformed'

/** Why one `agent-<id>.meta.json` never became an `AgentRecord` — its
 *  siblings are unaffected, so a single malformed file never drops the rest
 *  of the scan. */
export interface MetaProblem {
  readonly sessionId: string
  readonly agentId: string
  readonly kind: MetaProblemKind
  readonly message: string
}

export type SessionFailureKind = 'sdk-unavailable' | 'sdk-failed' | 'claude-home-missing' | 'projects-unreadable'

/**
 * Direction of failure: closed on the answer, open on reporting. No path
 * returns `sessions: []` for a scan that did not succeed — an empty board is
 * the one output an operator reads as "nothing is running". A partial scan
 * is the single case that returns `ok: true` with real data alongside the
 * named gaps, because dropping the sessions that did resolve would be
 * discarding good data to punish a bad one.
 */
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

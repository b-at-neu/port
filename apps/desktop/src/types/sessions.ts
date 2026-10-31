import type { TranscriptTailOpen, TranscriptTailPoll, EntryPatch, TranscriptEntry } from '@/utils/sessions/transcript'

// Renderer-safe session and agent shapes for the local session adapter. No import here may reach a Node builtin or the Agent SDK — only `main/sessions/` touches either.
import type { RepoId } from '@/utils/repos'
import type { LocalRepoRef } from '@/types/github'

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

export interface ReadSessionStateParams {
  readonly repos: readonly LocalRepoRef[]
  readonly claudeHome?: string
  readonly reader?: SessionReader
  readonly now?: () => Date
}

export type ProjectIndex = ReadonlyMap<string, string>

/** The injectable seam every caller takes instead of importing the SDK directly, so `adapter.test.ts` runs with no SDK present. */
export type SessionReader = () => Promise<ListSessionsResult>

export type ListSessionsResult =
  | { readonly ok: true; readonly sessions: readonly RawSession[] }
  | { readonly ok: false; readonly kind: SessionFailureKind; readonly message: string }

/** Mapped from the SDK's `SDKSessionInfo` — optional fields carried as `null`, and `lastModified` normalized to an ISO string here. */
export interface RawSession {
  readonly sessionId: string
  readonly summary: string | null
  readonly lastModified: string
  readonly customTitle: string | null
  readonly firstPrompt: string | null
  readonly gitBranch: string | null
  readonly cwd: string | null
}

export interface OpenTailParams {
  readonly sessionId: string
  readonly agentId: string | null
  readonly claudeHome?: string
}

export interface PollTailParams {
  readonly tailId: string
}

export interface CloseTailParams {
  readonly tailId: string
}

export interface TranscriptTailStore {
  openTail(params: OpenTailParams): Promise<TranscriptTailOpen>
  pollTail(params: PollTailParams): Promise<TranscriptTailPoll>
  closeTail(params: CloseTailParams): void
  /** Test-only introspection -- how many tails are currently held open. */
  readonly size: number
}

export interface DerivedChunk {
  readonly appended: readonly TranscriptEntry[]
  readonly patched: readonly EntryPatch[]
}

export interface Deriver {
  /** Returns only this batch's delta, never the whole transcript, so a caller can apply it directly onto a list it already holds. */
  push(records: readonly unknown[]): DerivedChunk
}

/** Main-process-only -- never crosses IPC. Holds the `Deriver` and everything `advanceTranscript` needs to resume. */
export interface TranscriptCursor {
  readonly path: string
  readonly sessionId: string
  readonly agentId: string | null
  readonly offset: number
  readonly nextIndex: number
  readonly recordCount: number
  readonly malformedLines: number
  readonly deriver: Deriver
}

export interface OpenTranscriptParams {
  readonly sessionId: string
  readonly agentId: string | null
  readonly claudeHome?: string
  /** Skips this call's own `buildProjectIndex` when the caller already built one, rather than re-listing `<claudeHome>/projects/` once per transcript. */
  readonly index?: ProjectIndex
}

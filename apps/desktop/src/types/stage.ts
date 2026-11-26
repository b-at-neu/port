import type { StageLauncher, StageLaunchResult, StageRecord } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import type { InterruptedReason, Run, RunDenial, Stage } from '@/utils/pipeline/ticket'
import type { GitHubRepoRef } from '@/types/github'
import type { BranchHead } from '@/types/release'

// Renderer-safe types for stage-session "needs you" attention: a denied tool call waiting on an
// allowlist decision, and a stage session interrupted before it reached a hand-back.
import type { PipelineItemKind } from '@/types/github'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { StageAgent } from '@/types/tick'
import type { RepoId } from '@/utils/repos'

/** A single off-allowlist tool call a stage session's policy denied. Kept on its run, deduped per repository by `rule` and bounded to 20 — a repeated denial simply re-raises the item. */
export interface StageDenial {
  readonly id: string
  readonly repoId: RepoId
  readonly agent: StageAgent
  readonly number: number
  readonly toolName: string
  /** Capped at 200 chars — enough to recognize the call, never the whole input. */
  readonly inputSummary: string
  readonly rule: string
  readonly at: string
  /** The session that raised it — `null` when the launcher could not name one, which shows in Needs you as a non-live row. */
  readonly sessionKey: SessionKey | null
}

export type { InterruptedReason }

/** A stage session that ended without reaching a `completed`/`questions`/`blocked` hand-back — its run is kept until it is resumed, restarted, or the operator clears its label by hand. Also kept, as `cleanup-failed`, when a `completed` session's worktree could not be removed. */
export interface InterruptedStage {
  readonly id: string
  readonly repoId: RepoId
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly stage: Stage
  readonly model: string
  /** The dispatcher's `#<n> <title>` label; absent on entries written before it was recorded. */
  readonly title?: string
  /** `null` when the session died before the SDK ever minted one — Resume has nothing to resume. */
  readonly claudeSessionId: string | null
  /** `branch` is `null` for a detached worktree. */
  readonly worktree: { readonly path: string; readonly branch: string | null; readonly baseSha: string }
  readonly startedAt: string
  /** When this entry last left `running` — the sweeper compares it against newer dispatch records. */
  readonly interruptedAt: string
  readonly reason: InterruptedReason
  readonly detail: string | null
  /** The instant a `usage-limit` clears or the next automatic retry of a `network` entry is due. */
  readonly resetsAt: string | null
  readonly costUsd: number | null
  /** How many times this entry was resumed after a network failure — `0` for any other reason, and for an entry written before the field existed. */
  readonly networkRetries: number
}

export type StageAllowResult =
  | { readonly kind: 'proposed'; readonly number: number; readonly url: string }
  | { readonly kind: 'already-proposed'; readonly number: number; readonly url: string }
  | { readonly kind: 'already-allowed'; readonly integration: string }
  | { readonly kind: 'invalid-rule'; readonly reason: string }
  | { readonly kind: 'failed'; readonly step: 'read' | 'commit' | 'pr'; readonly message: string }
  | { readonly kind: 'unknown-denial' }

export type AllowBaseRead =
  | { readonly ok: true; readonly head: BranchHead; readonly settingsText: string | null; readonly configText: string; readonly openPr: { readonly number: number; readonly url: string } | null }
  | { readonly ok: false; readonly message: string }

export interface ReadAllowBaseParams {
  readonly repo: GitHubRepoRef
  readonly integration: string
  readonly branch: string
}

export interface ProposeAllowParams {
  readonly head: BranchHead
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly rule: string
  readonly denial: StageDenial
  readonly integration: string
}

export type StageResumeResult =
  | { readonly kind: 'ok'; readonly sessionKey: string }
  | { readonly kind: 'at-capacity'; readonly limit: number }
  | { readonly kind: 'no-session-id' }
  | { readonly kind: 'start-failed'; readonly message: string }
  | { readonly kind: 'unknown-stage' }

export type StageRestartResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'worktree-dirty' }
  | { readonly kind: 'worktree-remove-failed'; readonly message: string }
  | { readonly kind: 'label-refused'; readonly reason: string }
  | { readonly kind: 'unknown-stage' }

export type StageInstructionsResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }

/** The bundled agent file's `description`, body and tool lists — structurally the SDK's `AgentDefinition` minus `model`, which the stage's own config supplies. */
export interface StageAgentDefinition {
  readonly description: string
  readonly prompt: string
  readonly tools?: string[]
  readonly disallowedTools?: string[]
}

export interface StageBundleRootInput {
  readonly isPackaged: boolean
  /** `__dirname` of the running main bundle — `out/main` in both dev and packaged builds. */
  readonly mainDir: string
  readonly resourcesPath: string
}

/** The inline agent a stage session runs as. */
export interface StageAgentLaunch {
  readonly name: string
  readonly definition: StageAgentDefinition
  /** True when `definition.prompt` holds the full instructions and stage context, which makes the session safe to compact. */
  readonly selfContained: boolean
}

export type StageLoadedInstructions = { readonly ok: true; readonly text: string; readonly agent: StageAgentLaunch } | { readonly ok: false; readonly message: string }

export interface StageResumeRequest {
  readonly entry: InterruptedStage
  readonly root: ResolvedStageRoot
  readonly prompt: string
}

export interface StageLauncherHandle extends StageLauncher {
  /** Wired from `main/ipc.ts`'s own `onStatus` — classifies a hand-back once per new `lastResult`/`end`, serialized per session key. */
  observe(snapshot: HostedSessionSnapshot): void
  /** Resumes an interrupted entry's kept worktree as a tracked session — its hand-back settles the same run, which opens again in place. */
  resume(request: StageResumeRequest): Promise<StageLaunchResult>
}

export interface ResolvedStageRoot {
  readonly path: string
  readonly sessionRequiredPaths: readonly string[]
}

/** A hand-back the last boot found unwritten, ready for the dispatcher to settle again. */
export interface UnsettledStage {
  readonly record: StageRecord & { readonly sessionKey: SessionKey }
  readonly outcome: StageOutcome
}

/** What a launch that never produced a session records, so the attempt still shows as a run. */
export interface LaunchFailure {
  readonly stage: Stage
  readonly kind: PipelineItemKind
  readonly number: number
  readonly agent: StageAgent
  readonly trigger: LabelKey
  readonly model: string
  readonly title: string | null
  readonly message: string
}

/** Every stage-session run a ticket carries. A write is one `RunChange` on the pipeline state, resolved once it is on disk and never rejecting; a read is a projection of `Ticket.runs`. */
export interface RunStore {
  start(repoId: RepoId, run: Run): Promise<void>
  launchFailed(repoId: RepoId, failure: LaunchFailure): Promise<void>
  /** Flips an interrupted run back to open under a new session; resuming a `network` interruption counts one retry. */
  resumed(repoId: RepoId, runId: string, sessionKey: SessionKey): Promise<void>
  session(repoId: RepoId, runId: string, claudeSessionId: string): Promise<void>
  joined(repoId: RepoId, runId: string, at: string): Promise<void>
  /** A hand-back that leaves the session open: questions or a block. */
  handback(repoId: RepoId, runId: string, outcome: StageOutcome): Promise<void>
  ended(repoId: RepoId, runId: string, outcome: StageOutcome | null): Promise<void>
  /** A `network` reason sets `resetsAt` to the next backoff instant itself and keeps the retry count; any other reason resets the count. */
  interrupt(repoId: RepoId, runId: string, interruption: { readonly reason: InterruptedReason; readonly detail: string | null; readonly resetsAt: string | null; readonly costUsd: number | null; readonly outcome: StageOutcome | null }): Promise<void>
  /** The row leaves Needs you; the run stays as history. */
  cleared(repoId: RepoId, runId: string): Promise<void>
  denied(repoId: RepoId, runId: string, denial: RunDenial): Promise<void>
  dismissDenial(repoId: RepoId, id: string): Promise<void>
  clearRule(repoId: RepoId, rule: string): Promise<void>
  /** Marks every open run `quit` — awaited at the quit path with a timeout the caller applies, since a hung write must never block quitting. */
  quitAll(): Promise<void>
  /** Interrupted runs, every repository unless one is named. */
  list(repoId?: RepoId): readonly InterruptedStage[]
  /** Runs whose session may still be going. */
  running(): readonly InterruptedStage[]
  denials(repoId: RepoId): readonly StageDenial[]
  /** Every run of the repository as a dispatch record, oldest first. */
  records(repoId: RepoId): readonly StageRecord[]
  runsOf(repoId: RepoId, kind: PipelineItemKind, number: number): readonly Run[]
  /** The hand-backs the last boot found unwritten, once. */
  unsettled(repoId: RepoId): readonly UnsettledStage[]
}

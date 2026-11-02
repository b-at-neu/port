import type { StageLaunchRequest, StageLauncher, StageLaunchResult } from '@/types/dispatch'
import type { HostedSessionSnapshot, HostedStore, SessionKey } from '@/types/hosting'
import type { ReleaseBranchOutcome, RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { ItemActionResult } from '@/types/actions'
import type { GhRunner } from '@/types/platform'
import type { GitHubRepoRef } from '@/types/github'
import type { BranchHead } from '@/types/release'
import type { AllowWriteContext, AllowWriteResult } from '@/types/writes'

// Renderer-safe types for stage-session "needs you" attention: a denied tool call waiting on an
// allowlist decision, and a stage session interrupted before it reached a hand-back.
import type { PipelineItemKind } from '@/types/github'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { StageAgent } from '@/types/tick'
import type { RepoId } from '@/utils/repos'

/** A single off-allowlist tool call a stage session's policy denied. Persisted in `stage-denials.json`, deduped per repository by `rule` and bounded to 20 — a repeated denial simply re-raises the item. */
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

export interface StageDenialStore {
  /** Loads `stage-denials.json`; a missing or malformed file, or an entry failing the guard, loads as empty. */
  load(): Promise<void>
  /** Dedupes by rule within the repository and bounds it to 20. */
  record(denial: StageDenial): void
  dismiss(repoId: RepoId, id: string): void
  clearRule(repoId: RepoId, rule: string): void
  list(repoId: RepoId): readonly StageDenial[]
}

export const INTERRUPTED_REASONS = ['quit', 'crash', 'usage-limit', 'error', 'cleanup-failed'] as const
export type InterruptedReason = (typeof INTERRUPTED_REASONS)[number]

/** A stage session that ended without reaching a `completed`/`questions`/`blocked` hand-back — tracked in `stage-sessions.json` until it is resumed, restarted, or the operator clears its label by hand. Also kept, as `cleanup-failed`, when a `completed` session's worktree could not be removed. */
export interface InterruptedStage {
  readonly id: string
  readonly repoId: RepoId
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly inFlight: LabelKey
  readonly model: string
  /** `null` when the session died before the SDK ever minted one — Resume has nothing to resume. */
  readonly claudeSessionId: string | null
  /** `branch` is `null` for a detached worktree. */
  readonly worktree: { readonly path: string; readonly branch: string | null; readonly baseSha: string }
  readonly startedAt: string
  /** When this entry last left `running` — the sweeper compares it against newer dispatch records. */
  readonly interruptedAt: string
  readonly reason: InterruptedReason
  readonly detail: string | null
  readonly resetsAt: string | null
  readonly costUsd: number | null
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
  readonly gh?: GhRunner
}

export interface ProposeAllowParams {
  readonly head: BranchHead
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly rule: string
  readonly denial: StageDenial
  readonly integration: string
}

/** The two GitHub seams "Allow from now on" composes through, injected at the composition root. */
export interface StageAllowIo {
  readonly read: (params: ReadAllowBaseParams) => Promise<AllowBaseRead>
  readonly propose: (ctx: AllowWriteContext, params: ProposeAllowParams) => Promise<AllowWriteResult>
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

export type StageInstructionsResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string; readonly kind?: 'missing-section' }

/** Resolves to the full first message: the dispatch line, the stage context, and the installed plugin's instructions. */
export type StageInstructionsLoader = (request: StageLaunchRequest, worktreePath: string) => Promise<StageInstructionsResult>

export interface StageResumeRequest {
  readonly entry: InterruptedStage
  readonly root: ResolvedStageRoot
  readonly prompt: string
}

export interface StageLauncherHandle extends StageLauncher {
  /** Wired from `main/ipc.ts`'s own `onStatus` — classifies a hand-back once per new `lastResult`/`end`, serialized per session key. */
  observe(snapshot: HostedSessionSnapshot): void
  /** Resumes an interrupted entry's kept worktree as a tracked session — its hand-back settles the same registry entry, and the entry flips back to `running` in place. */
  resume(request: StageResumeRequest): Promise<StageLaunchResult>
}

export interface RecoverDeps {
  readonly registry: StageRegistry
  readonly store: Pick<HostedStore, 'list'>
  readonly resume: StageLauncherHandle['resume']
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly releaseBranch: (root: string, branch: string, baseSha: string) => Promise<ReleaseBranchOutcome>
  readonly resolveEntry: (repoId: InterruptedStage['repoId']) => ResolvedStageRoot | null
  readonly applyRetry: (interrupted: InterruptedStage) => Promise<ItemActionResult>
  readonly capacity: () => Promise<{ readonly limit: number }>
}

export interface ResolvedStageRoot {
  readonly path: string
  readonly sessionRequiredPaths: readonly string[]
}

export interface StageRegistry {
  /** Loads the file, promoting every `running` entry found to `crash` — a `running` record at boot can only mean the process died before it marked itself otherwise. Missing/malformed loads as empty. */
  load(): Promise<readonly InterruptedStage[]>
  /** Replaces any entry already holding the same `id`, never appends a second one. */
  recordRunning(entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd' | 'interruptedAt'>): void
  /** Flips an interrupted entry back to `running` in place — a no-op for an unknown id. */
  markRunning(id: string): void
  setSessionId(id: string, claudeSessionId: string): void
  markInterrupted(id: string, reason: InterruptedReason, detail: string | null, resetsAt: string | null, costUsd: number | null): void
  /** Marks every currently-`running` entry `quit` — called on the quit path before `closeAll()`. */
  /** Awaited at the quit path, with a timeout the caller applies — a hung write must never block quitting. */
  markAllQuit(): Promise<void>
  remove(id: string): void
  list(): readonly InterruptedStage[]
}

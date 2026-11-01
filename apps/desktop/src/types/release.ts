// Renderer-safe contract for the Releases screen: the status read, the phase it resolves to, and the two `release:run` steps.
import type { GhRunner, PathOps } from '@/types/platform'
import type { RepoId } from '@/utils/repos'

export interface PullLink {
  readonly number: number
  readonly url: string
}

export type VersionKind = 'major' | 'minor' | 'patch'

export interface VersionCandidate {
  readonly kind: VersionKind
  readonly version: string
  readonly recommended: boolean
  readonly reason: string
  readonly tickets: readonly number[]
}

export interface ReleaseEntry {
  readonly number: number | null
  readonly title: string
  readonly labels: readonly string[]
  readonly dependency: boolean
}

export interface ReleaseInfo {
  readonly tagName: string
  readonly name: string
  readonly url: string
  readonly publishedAt: string | null
  readonly isPrerelease: boolean
  readonly isLatest: boolean
  readonly description: string
}

export type ReleaseVersionSource = 'tags' | 'package'

/** The `release` block of `.claude/port.config.json`, defaults filled in. */
export interface ReleaseConfig {
  readonly versionSource: ReleaseVersionSource
  readonly versionFiles: readonly string[]
  readonly versionCommand: string | null
  readonly postPublishHook: string | null
}

export type ReleaseConfigRead = { readonly ok: true; readonly config: ReleaseConfig } | { readonly ok: false; readonly message: string }

export interface ReleaseWriteContext {
  readonly repo: string
  readonly repoId: RepoId
  readonly version: string
  readonly auditDir: string
  readonly scratchDir: string
  readonly gh?: GhRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

export type ReleaseWriteResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly stderr: string }

export interface VersionFileWrite {
  readonly path: string
  readonly content: string
}

/** Every phase `resolvePhase` can return; the five without a payload are the guards plus the two idle shapes. */
export type ReleasePhase =
  | { readonly kind: 'off' }
  | { readonly kind: 'single-branch' }
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'needs-terminal' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'nothing-to-release' }
  | { readonly kind: 'bumped'; readonly version: string }
  | { readonly kind: 'waiting-bump'; readonly version: string; readonly bumpPr: PullLink | null; readonly releasePr: PullLink | null }
  | { readonly kind: 'waiting-merge'; readonly version: string | null; readonly releasePr: PullLink }
  | { readonly kind: 'ready-to-publish'; readonly version: string }
  | { readonly kind: 'abandoned'; readonly version: string; readonly releasePr: PullLink }
  | { readonly kind: 'conflict'; readonly branches: readonly string[] }

export interface BumpBranchInput {
  readonly name: string
  readonly pr: PullLink | null
}

export interface ReleasePrInput extends PullLink {
  readonly title: string
}

export interface ClosedReleasePrInput extends ReleasePrInput {
  readonly merged: boolean
}

/** Everything `resolvePhase` reads — all of it derived from GitHub, none from the renderer. */
export interface PhaseInput {
  readonly moduleEnabled: boolean
  readonly production: string | null
  readonly versionSource: ReleaseVersionSource
  readonly versionFiles: readonly string[]
  readonly versionCommand: string | null
  readonly bumpBranches: readonly BumpBranchInput[]
  readonly openReleasePr: ReleasePrInput | null
  readonly lastClosedReleasePr: ClosedReleasePrInput | null
  readonly publishedTags: ReadonlySet<string>
  readonly integrationVersion: string | null
  readonly productionVersion: string | null
  readonly gatherEmpty: boolean
}

export interface ReleaseStatus {
  readonly phase: ReleasePhase
  readonly versionSource: ReleaseVersionSource
  readonly production: string | null
  readonly integration: string
  readonly currentVersion: string | null
  readonly candidates: readonly VersionCandidate[]
  readonly entries: readonly ReleaseEntry[]
  readonly truncatedNote: string | null
  readonly releases: readonly ReleaseInfo[]
  readonly productionHead: string | null
  readonly postPublishHook: string | null
  readonly readAt: string
}

export type ReleaseStatusResponse =
  | { readonly ok: true; readonly status: ReleaseStatus }
  | { readonly ok: false; readonly message: string; readonly readAt: string }

export interface BranchHead {
  readonly oid: string
  readonly tree: string
}

/** Main's own read: the status the renderer sees, plus the integration head a bump commit is parented on and the signed-in login a release pull request is assigned to. */
export type ReleaseRead =
  | { readonly ok: true; readonly status: ReleaseStatus; readonly integrationHead: BranchHead | null; readonly viewer: string | null }
  | { readonly ok: false; readonly message: string; readonly readAt: string }

export type ReleaseRunRequest =
  | { readonly repoId: RepoId; readonly step: 'open'; readonly version: string }
  | { readonly repoId: RepoId; readonly step: 'publish'; readonly version: string; readonly notes: string }

export type HookOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly exitCode: number | null; readonly stderr: string }
  | { readonly kind: 'unrunnable'; readonly message: string }

export type ReleaseRefusal = 'state-changed' | 'invalid-version' | 'tag-exists' | 'unsupported'

export type ReleaseRunResult =
  | { readonly kind: 'opened' }
  | { readonly kind: 'published'; readonly url: string; readonly hook: HookOutcome }
  | { readonly kind: 'refused'; readonly reason: ReleaseRefusal; readonly message: string }
  | { readonly kind: 'failed'; readonly step: 'bump' | 'bump-pr' | 'release-pr' | 'publish'; readonly stderr: string }

export type ReleaseAuditAction = 'release-bump' | 'release-pr' | 'release-publish' | 'release-hook'

/** One line per attempt in `writes.jsonl`; `call` is the last argv that ran. */
export interface ReleaseAuditEntry {
  readonly at: string
  readonly repo: string
  readonly repoId: RepoId
  readonly action: ReleaseAuditAction
  readonly version: string
  readonly call: readonly string[] | null
  readonly result: 'applied' | 'failed'
  readonly failure: string | null
}

/** A group's view, built by `renderer/releases/model.ts` from one repository's query state. */
export type ReleaseGroupView =
  | { readonly kind: 'loading'; readonly repoId: RepoId; readonly repo: string }
  | { readonly kind: 'error'; readonly repoId: RepoId; readonly repo: string; readonly message: string }
  | { readonly kind: 'loaded'; readonly repoId: RepoId; readonly repo: string; readonly status: ReleaseStatus }

/** The slice of a TanStack query the model reads; `status` stays `'success'` on a failed refetch over good data, so `isError`/`dataUpdatedAt` say so. */
export interface ReleaseQueryLike {
  readonly status: 'pending' | 'error' | 'success'
  readonly data: ReleaseStatusResponse | undefined
  readonly isError: boolean
  readonly errorMessage: string | null
  readonly dataUpdatedAt: number
}

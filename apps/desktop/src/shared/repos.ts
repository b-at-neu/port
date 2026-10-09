// The types every process shares for the repo registry — the renderer never manipulates a path, only displays what main resolved and hands `id` back verbatim. Types only: inspection and persistence live in src/main/registry/.
import type { LabelVocabulary } from './labels/vocabulary'
import type { AppliedOverride, OverrideValue } from '../../../../scripts/port-tick/overrides'
export type { AppliedOverride, OverrideValue }

declare const repoIdBrand: unique symbol

/** Branded string minted only by main — a raw path cannot be passed where an id is expected, so importing this type asserts "this came from the registry". */
export type RepoId = string & { readonly [repoIdBrand]: true }

/** One violation ajv reported, in a shape an operator can read without knowing JSON Schema. */
export interface SchemaViolation {
  readonly path: string
  readonly message: string
}

/** The subset of `FileFailureKind` that reaches a registry entry — `not-found` becomes `not-port-managed` and `unparseable` becomes `config-malformed` before a problem is built, so neither appears here. */
export type RepoConfigReadFailureKind = 'not-a-file' | 'permission-denied' | 'too-large' | 'io'

/** Why a repository never became `ready`. `effective-config-unreadable` is distinct from `config-unreadable`: the latter is the port config itself, the former is a file read *after* that config resolved — an unread override can rename a label or change a gate, so this app refuses to act rather than silently running on defaults. */
export type RepoProblem =
  | { readonly kind: 'directory-missing' }
  | { readonly kind: 'not-a-git-repository' }
  | { readonly kind: 'not-port-managed'; readonly carriedBy: readonly string[]; readonly currentBranch: string }
  | { readonly kind: 'config-unreadable'; readonly reason: RepoConfigReadFailureKind; readonly message: string }
  | { readonly kind: 'config-malformed'; readonly message: string }
  | { readonly kind: 'config-invalid'; readonly violations: readonly SchemaViolation[] }
  | { readonly kind: 'effective-config-unreadable'; readonly file: 'CLAUDE.md' | '.github/workflows/approval-check.yml'; readonly reason: RepoConfigReadFailureKind; readonly message: string }

/** Non-disqualifying — carried on a `ready` entry, listed but never blocking. */
export type RepoDiagnostic =
  | { readonly kind: 'off-integration-branch'; readonly branch: string; readonly integration: string }
  | { readonly kind: 'detached-head'; readonly sha: string }
  | { readonly kind: 'permissions-missing' }
  | { readonly kind: 'permissions-empty' }
  | { readonly kind: 'schema-violations'; readonly violations: readonly SchemaViolation[] }
  | { readonly kind: 'git-unavailable' }
  /** One refused `CLAUDE.md` override-block line — `path` is `null` for a block-level parse problem, the overridden path otherwise; `line` is the offending source line, `reason` is the refusal wording. */
  | { readonly kind: 'override-refused'; readonly path: string | null; readonly line: string; readonly reason: string }

/** One check's disposition: `blocking` (default — a red conclusion forms a finding and blocks) or `infrastructure` (red is reported, never blocks). A later `CLAUDE.md` entry can overwrite the approval-gate's own name. */
export interface CheckDisposition {
  readonly disposition: 'blocking' | 'infrastructure'
  readonly source: 'approval-gate' | 'CLAUDE.md'
}

/** Everything a repository's config resolves to once it is `ready` — `owner`/`name` split off `repo`, every absent key defaulted off the imported schema, `labels` exposed only as a resolved vocabulary. */
export interface ResolvedRepoConfig {
  readonly repo: string
  readonly owner: string
  readonly name: string
  /** `production` is `string | null` — a `CLAUDE.md` override can set `branches.production = null`, the same single-branch-mode meaning `port.config.json` itself carries. */
  readonly branches: { readonly integration: string; readonly production: string | null }
  readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
  readonly modules: {
    readonly approvalGate: boolean
    readonly release: boolean
    readonly scope: boolean
  }
  readonly reviewCycleCap: number
  readonly vocabulary: LabelVocabulary
  /** `worktrees` is the full `commands.worktrees` prefix, `null` meaning the repository has not installed the reclamation script. `budget` is the same shape, `null` meaning nothing measures or bounds ticket cost. */
  readonly commands: { readonly worktrees: string | null; readonly budget: string | null }
  /** The file-contention gate's own tuning — `sharedFiles` never contributes to a hold, `overlapThreshold` is how many non-shared paths an in-flight item must share with a candidate before it holds. */
  readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
  /** The approval-withdrawal observation's own check dispositions. The approval-gate's own excusal folds in first, then every applied `checks.<name>` `CLAUDE.md` override, a later entry overwriting the same key. */
  readonly checkDispositions: Readonly<Record<string, CheckDisposition>>
  /** Every `CLAUDE.md` `port-overrides` entry this repository's config actually applied, in block order. Refused lines are reported as diagnostics instead, never silently dropped. */
  readonly overrides: readonly AppliedOverride[]
}

/** Discriminated on status, so "ready implies a config" is enforced by the type rather than an optional field a caller could forget to check. */
export type RepositoryEntry =
  | {
      readonly id: RepoId
      readonly path: string
      readonly displayName: string
      readonly status: 'ready'
      readonly config: ResolvedRepoConfig
      readonly diagnostics: readonly RepoDiagnostic[]
    }
  | {
      readonly id: RepoId
      readonly path: string
      readonly displayName: string
      readonly problem: RepoProblem
      readonly diagnostics: readonly RepoDiagnostic[]
    }

/** Narrows a `RepositoryEntry` to its `ready` variant — shared so the backlog screen and claim controller apply the same test rather than each carrying its own copy. */
export function isReadyRepo(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { readonly status: 'ready' }> {
  return 'config' in entry
}

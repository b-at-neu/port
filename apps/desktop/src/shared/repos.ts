// The types every process shares for the repo registry (#74) — the renderer
// never manipulates a path (#72's boundary), so it only ever displays what
// main resolved and hands `id` back verbatim. Types only: no import from
// src/main/, so this file compiles under tsconfig.web.json with no Node
// types, and no logic — inspection and persistence live in
// src/main/registry/.
import type { LabelVocabulary } from './labels/vocabulary'
import type { AppliedOverride, OverrideValue } from '../../../../scripts/port-tick/overrides'
export type { AppliedOverride, OverrideValue }

declare const repoIdBrand: unique symbol

/** Branded string minted only by main, from `pathOps.pathKey(root)` — a raw
 *  path cannot be passed where an id is expected, so a call site importing
 *  this type is asserting "this came from the registry", not "this looks
 *  like a path". */
export type RepoId = string & { readonly [repoIdBrand]: true }

/** One violation ajv reported, in a shape an operator can read without
 *  knowing JSON Schema — `path` is the instance path with an empty root
 *  rendered as `'(document root)'`, `message` is ajv's own wording. */
export interface SchemaViolation {
  readonly path: string
  readonly message: string
}

/** The subset of `FileFailureKind` (`main/platform/files.ts`) that reaches a
 *  registry entry — `not-found` becomes `not-port-managed` and
 *  `unparseable` becomes `config-malformed` before a problem is ever built,
 *  so neither appears here. Redeclared rather than imported: this file may
 *  import nothing from `src/main/`. */
export type RepoConfigReadFailureKind = 'not-a-file' | 'permission-denied' | 'too-large' | 'io'

/** Why a repository never became `ready`. Each variant carries exactly what
 *  its copy in the repository card needs, per the ticket's problem table.
 *  `effective-config-unreadable` (#300) is distinct from `config-unreadable`:
 *  the latter is `.claude/port.config.json` itself, the former is one of the
 *  two files `main/registry/effective.ts` reads *after* that config already
 *  resolved (`CLAUDE.md`, or `.github/workflows/approval-check.yml` when
 *  `modules.approvalGate` is on) — an unread override can rename a label or
 *  change a gate, so this app refuses to act on the repository rather than
 *  silently running on port defaults for a block it could not actually
 *  read. */
export type RepoProblem =
  | { readonly kind: 'directory-missing' }
  | { readonly kind: 'not-a-git-repository' }
  | { readonly kind: 'not-port-managed'; readonly carriedBy: readonly string[]; readonly currentBranch: string }
  | { readonly kind: 'config-unreadable'; readonly reason: RepoConfigReadFailureKind; readonly message: string }
  | { readonly kind: 'config-malformed'; readonly message: string }
  | { readonly kind: 'config-invalid'; readonly violations: readonly SchemaViolation[] }
  | { readonly kind: 'effective-config-unreadable'; readonly file: 'CLAUDE.md' | '.github/workflows/approval-check.yml'; readonly reason: RepoConfigReadFailureKind; readonly message: string }

/** Non-disqualifying — carried on a `ready` entry, listed but never
 *  blocking. */
export type RepoDiagnostic =
  | { readonly kind: 'off-integration-branch'; readonly branch: string; readonly integration: string }
  | { readonly kind: 'detached-head'; readonly sha: string }
  | { readonly kind: 'permissions-missing' }
  | { readonly kind: 'permissions-empty' }
  | { readonly kind: 'schema-violations'; readonly violations: readonly SchemaViolation[] }
  | { readonly kind: 'git-unavailable' }
  /** One refused `CLAUDE.md` override-block line (#300) — `path` is `null`
   *  for a block-level parse problem (no entry to name), the overridden path
   *  otherwise; `line` is the offending source line or marker, `reason` is
   *  `scripts/port-tick/overrides.ts`'s own refusal wording. */
  | { readonly kind: 'override-refused'; readonly path: string | null; readonly line: string; readonly reason: string }

/** One check's disposition (#246, #292, generalized to the app in #300):
 *  `blocking` (default — a red conclusion forms a finding and blocks) or
 *  `infrastructure` (red is reported, forms no finding, never blocks).
 *  `source` is `'approval-gate'` for the approval-check workflow's own
 *  derived excusal, `'CLAUDE.md'` for an applied `checks.<name>` override — a
 *  later `CLAUDE.md` entry can overwrite the approval-gate's own name, per
 *  `main/registry/effective.ts`'s `foldDispositions`. */
export interface CheckDisposition {
  readonly disposition: 'blocking' | 'infrastructure'
  readonly source: 'approval-gate' | 'CLAUDE.md'
}

/** Everything a repository's config resolves to once it is `ready` —
 *  `owner`/`name` split off `repo` (the schema's `pattern` guarantees the
 *  single `/`), every absent key defaulted off the imported schema, and
 *  `labels` exposed only as a resolved vocabulary, never raw overrides. */
export interface ResolvedRepoConfig {
  readonly repo: string
  readonly owner: string
  readonly name: string
  /** `production` is `string | null` (#300) — a `CLAUDE.md` override can set
   *  `branches.production = null`, the same single-branch-mode meaning
   *  `port.config.json` itself already carries. */
  readonly branches: { readonly integration: string; readonly production: string | null }
  readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
  readonly modules: {
    readonly approvalGate: boolean
    readonly release: boolean
    readonly scope: boolean
  }
  readonly reviewCycleCap: number
  readonly vocabulary: LabelVocabulary
  /** `worktrees` is the full `commands.worktrees` prefix (#86) — `string |
   *  null`, `null` meaning the repository has not installed the reclamation
   *  script. Nothing here validates or spawns it; that is `main/reclaimer/`'s
   *  job. */
  /** `budget` (#265) is the same full-command-prefix shape as `worktrees` —
   *  `null` means nothing measures or bounds ticket cost. The app's own
   *  dispatcher refuses to dispatch at all for a repository that sets it,
   *  rather than silently skipping the ceiling the cockpit would enforce
   *  (a follow-up ports the gate itself). */
  readonly commands: { readonly worktrees: string | null; readonly budget: string | null }
  /** The file-contention gate's own tuning (#106) — `sharedFiles` never
   *  contributes to a hold in either direction, `overlapThreshold` is how
   *  many non-shared paths one in-flight item must share with a candidate
   *  before it holds. Both come off the schema's own defaults when absent. */
  readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
  /** The approval-withdrawal observation's own check dispositions (#292),
   *  generalized into the cockpit's own map shape (#300) —
   *  `Record<name, CheckDisposition>`, resolved by `main/registry/
   *  effective.ts`'s `foldDispositions` and applied by `main/registry/
   *  inspect.ts`. The approval-gate's own excusal folds in first (when
   *  `modules.approvalGate` is effectively true), then every applied
   *  `checks.<name>` `CLAUDE.md` override, a later entry overwriting the
   *  same key. */
  readonly checkDispositions: Readonly<Record<string, CheckDisposition>>
  /** Every `CLAUDE.md` `port-overrides` entry this repository's config
   *  actually applied (#300), in block order — `[]` when there is no block,
   *  or when every line in it was refused. Refused lines are reported as
   *  diagnostics (`override-refused`) instead, never silently dropped. */
  readonly overrides: readonly AppliedOverride[]
}

/** Discriminated on status, so "ready implies a config" is enforced by the
 *  type rather than an optional field a caller could forget to check. */
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

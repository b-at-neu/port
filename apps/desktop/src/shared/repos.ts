// The types every process shares for the repo registry (#74) — the renderer
// never manipulates a path (#72's boundary), so it only ever displays what
// main resolved and hands `id` back verbatim. Types only: no import from
// src/main/, so this file compiles under tsconfig.web.json with no Node
// types, and no logic — inspection and persistence live in
// src/main/registry/.
import type { LabelVocabulary } from './labels/vocabulary'

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
 *  its copy in the repository card needs, per the ticket's problem table. */
export type RepoProblem =
  | { readonly kind: 'directory-missing' }
  | { readonly kind: 'not-a-git-repository' }
  | { readonly kind: 'not-port-managed'; readonly carriedBy: readonly string[]; readonly currentBranch: string }
  | { readonly kind: 'config-unreadable'; readonly reason: RepoConfigReadFailureKind; readonly message: string }
  | { readonly kind: 'config-malformed'; readonly message: string }
  | { readonly kind: 'config-invalid'; readonly violations: readonly SchemaViolation[] }

/** Non-disqualifying — carried on a `ready` entry, listed but never
 *  blocking. */
export type RepoDiagnostic =
  | { readonly kind: 'off-integration-branch'; readonly branch: string; readonly integration: string }
  | { readonly kind: 'detached-head'; readonly sha: string }
  | { readonly kind: 'permissions-missing' }
  | { readonly kind: 'permissions-empty' }
  | { readonly kind: 'schema-violations'; readonly violations: readonly SchemaViolation[] }
  | { readonly kind: 'git-unavailable' }

/** Everything a repository's config resolves to once it is `ready` —
 *  `owner`/`name` split off `repo` (the schema's `pattern` guarantees the
 *  single `/`), every absent key defaulted off the imported schema, and
 *  `labels` exposed only as a resolved vocabulary, never raw overrides. */
export interface ResolvedRepoConfig {
  readonly repo: string
  readonly owner: string
  readonly name: string
  readonly branches: { readonly integration: string; readonly production: string }
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
  readonly commands: { readonly worktrees: string | null }
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

// Every pure string the Repositories screens render (#319) — moved out of
// the legacy `repositories.ts` (deleted in the routing/main commit, which
// imports these instead of defining them a second time until then). No DOM
// here.
import type { AppliedOverride, RepoDiagnostic, RepoProblem, ResolvedRepoConfig } from '../../../shared/repos'

const MODULE_LABELS: { readonly [K in keyof ResolvedRepoConfig['modules']]: string } = {
  approvalGate: 'approval gate',
  release: 'release',
  scope: 'scope',
}

export function problemCopy(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return "That folder is gone. It may have moved, or be on a drive that isn't mounted."
    case 'not-a-git-repository':
      return "Not a git repository. Pick the repository's root folder."
    case 'not-port-managed':
      return problem.carriedBy.length > 0
        ? `Not port-managed on ${problem.currentBranch}. The harness is on ${problem.carriedBy.join(', ')} — check one of those out and rescan.`
        : "Not port-managed. There's no .claude/port.config.json on any branch here. Run /port:init in this repository to adopt the pipeline."
    case 'config-malformed':
      return `.claude/port.config.json isn't valid JSON — ${problem.message}.`
    case 'config-invalid':
      return `.claude/port.config.json has no usable repo: ${problem.violations[0]?.message ?? 'invalid'}. Every GitHub query is scoped to it, so nothing can be read until it's set.`
    case 'config-unreadable':
      return `Can't read .claude/port.config.json — ${problem.message}.`
    case 'effective-config-unreadable':
      return problem.file === 'CLAUDE.md'
        ? `Can't read CLAUDE.md — ${problem.message}. Its port-overrides block can rename labels and change gates, so this app won't act on this repository until it can read it.`
        : `Can't read ${problem.file} — ${problem.message}. It names the check the approval gate excuses, so this app won't act on this repository until it can read it.`
  }
}

export function diagnosticCopy(diagnostic: RepoDiagnostic): string {
  switch (diagnostic.kind) {
    case 'off-integration-branch':
      return `On ${diagnostic.branch}, not ${diagnostic.integration}. Dispatched agents work from ${diagnostic.integration}, so what's on disk here isn't what they see.`
    case 'detached-head':
      return `Detached at ${diagnostic.sha}.`
    case 'permissions-missing':
      return 'No .claude/settings.json on this branch — dispatched agents would auto-deny every command.'
    case 'permissions-empty':
      return 'No permissions.allow on this branch — dispatched agents would auto-deny every command.'
    case 'schema-violations': {
      const first = diagnostic.violations[0]
      return `Config doesn't match the schema in ${diagnostic.violations.length} place(s): ${first ? `${first.path} ${first.message}` : ''}. Reading it anyway, with defaults for those fields.`
    }
    case 'git-unavailable':
      return "Couldn't run git, so branch checks were skipped."
    case 'override-refused':
      return `CLAUDE.md override refused: ${diagnostic.line} — ${diagnostic.reason}. The port value stands.`
  }
}

/** `portDefault`'s own rendering rule (#300, plan's own **UX states**): an
 *  array is comma-joined, `null` is `none`, `undefined` is `unset` — never
 *  the literal word `undefined`, which would read as a bug rather than "this
 *  field had no prior port value to show". */
function portDefaultCopy(portDefault: AppliedOverride['portDefault']): string {
  if (portDefault === undefined) return 'unset'
  if (portDefault === null) return 'none'
  if (Array.isArray(portDefault)) return portDefault.join(', ')
  return String(portDefault)
}

/** One applied `CLAUDE.md` override's own line (#300) — the exact words the
 *  cockpit's own startup preflight already prints, so an operator sees the
 *  same override described identically in both places. */
export function overrideLineCopy(override: AppliedOverride): string {
  return `override: ${override.path} = ${String(override.value)} (port default: ${portDefaultCopy(override.portDefault)}) — ${override.reason} — source: ${override.source}`
}

function moduleSummary(modules: ResolvedRepoConfig['modules']): string {
  const keys = Object.keys(MODULE_LABELS) as (keyof ResolvedRepoConfig['modules'])[]
  return keys
    .filter((key) => modules[key])
    .map((key) => MODULE_LABELS[key])
    .join(', ')
}

/** The repository card's own summary line, as parts to join with ` · ` —
 *  pure, so it is directly testable without building DOM. Single-branch mode
 *  (`production === null`) shows the integration branch alone, never
 *  `dev → null`. */
export function summaryParts(config: ResolvedRepoConfig): readonly string[] {
  const branchSummary = config.branches.production === null ? config.branches.integration : `${config.branches.integration} → ${config.branches.production}`
  const labelCount = config.vocabulary.labels.length
  return [branchSummary, `${labelCount} pipeline labels`, moduleSummary(config.modules)].filter((part) => part !== '')
}

export type RegistryErrorReason = 'unreadable' | 'malformed' | 'unsupported-version'

export interface RegistryBanner {
  readonly path: string
  readonly reason: RegistryErrorReason
}

export function registryBannerCopy(banner: RegistryBanner): string {
  const reason = banner.reason === 'unreadable' ? "couldn't be read" : banner.reason === 'malformed' ? "isn't valid JSON" : 'was written by a newer version of Port'
  return `Your repository list at ${banner.path} ${reason}. Nothing was changed — fix or delete that file and rescan.`
}

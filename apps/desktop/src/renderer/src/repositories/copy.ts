// Every pure string the Repositories screens render. No DOM here.
import type { AppliedOverride, RepoDiagnostic, RepoProblem, ResolvedRepoConfig } from '../../../shared/repos'
import type { LabelSource, VocabularyProblem, VocabularyVerdict } from '../../../shared/labels/vocabulary'
import type { OverviewModuleFlag } from './health-model'

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

// The list row's own short problem label — problemCopy above stays the
// long sentence shown on the per-repo Overview tab.
export function problemLabel(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return 'Folder missing'
    case 'not-a-git-repository':
      return 'Not a git repo'
    case 'not-port-managed':
      return 'Not port-managed'
    case 'config-malformed':
    case 'config-invalid':
      return 'Config invalid'
    case 'config-unreadable':
    case 'effective-config-unreadable':
      return 'Config unreadable'
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

// An array is comma-joined, null is none, undefined is unset — never the
// literal word undefined.
function portDefaultCopy(portDefault: AppliedOverride['portDefault']): string {
  if (portDefault === undefined) return 'unset'
  if (portDefault === null) return 'none'
  if (Array.isArray(portDefault)) return portDefault.join(', ')
  return String(portDefault)
}

// One applied CLAUDE.md override's own line, matching the cockpit's own
// startup preflight wording.
export function overrideLineCopy(override: AppliedOverride): string {
  return `override: ${override.path} = ${String(override.value)} (port default: ${portDefaultCopy(override.portDefault)}) — ${override.reason} — source: ${override.source}`
}

export function moduleSummary(modules: ResolvedRepoConfig['modules']): string {
  const keys = Object.keys(MODULE_LABELS) as (keyof ResolvedRepoConfig['modules'])[]
  return keys
    .filter((key) => modules[key])
    .map((key) => MODULE_LABELS[key])
    .join(', ')
}

// Parts to join with ' · '. Single-branch mode shows the integration
// branch alone, never 'dev → null'.
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

// --- Overview → Labels -------------------------------------------------

// The verdict line's own sentence, by `VocabularyVerdict`.
export function verdictCopy(verdict: VocabularyVerdict, total: number, missing: number, unverifiedReason: string | undefined): string {
  switch (verdict) {
    case 'verified':
      return `All ${String(total)} labels exist on GitHub.`
    case 'partial':
      return `${String(missing)} of ${String(total)} labels are missing on GitHub. Items carrying them won't show.`
    case 'mis-resolved':
      return `None of the ${String(total)} labels this config resolves exist on GitHub. Check \`labels\` in .claude/port.config.json and the CLAUDE.md overrides.`
    case 'unverified':
      return `Couldn't check labels on GitHub — ${unverifiedReason ?? 'unknown reason'}.`
  }
}

// `LabelSource`'s own values are already the exact display strings.
export function labelSourceCopy(source: LabelSource): string {
  return source
}

export function vocabularyProblemCopy(problem: VocabularyProblem): string {
  switch (problem.kind) {
    case 'unknown-key':
      return `'${problem.key}' in labels isn't a known label key.`
    case 'invalid-override':
      return `labels.${problem.key} is ${JSON.stringify(problem.value)}, not a non-empty string — the default name stands.`
    case 'collision':
      return `${problem.keys.join(', ')} all resolve to the name '${problem.name}' — only one can match on GitHub.`
    case 'case-mismatch':
      return `labels.${problem.key} resolves to '${problem.resolved}', but GitHub has it as '${problem.actual}'.`
  }
}

// --- Overview → Config -------------------------------------------------

// "approval gate on · release off · scope on" — every flag, in a fixed order.
export function moduleFlagCopy(flags: readonly OverviewModuleFlag[]): string {
  return flags.map((flag) => `${MODULE_LABELS[flag.name]} ${flag.on ? 'on' : 'off'}`).join(' · ')
}

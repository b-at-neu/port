// Resolves a repository's *effective* config (#300) — the port-resolved
// values `inspect.ts` already built, with a root `CLAUDE.md` `port-overrides`
// block folded on top, the same composition order the cockpit's own
// `scripts/port-tick/config.ts` `loadConfig` already follows:
//   1. Start from the port-resolved config.
//   2. Read CLAUDE.md and apply its block.
//   3. Resolve the approval-gate excusal against the *effective*
//      modules.approvalGate.
//   4. Fold the checks.* entries into one disposition map.
// Composition only — `overrides.ts`'s `parseOverrides`/`applyOverrides` do
// the actual parsing and validation; this module never duplicates either.
import { pathOps, readTextFile } from '../platform'
import { LABEL_DEFAULTS } from '../../shared/labels/defaults'
import { LABEL_KEYS } from '../../shared/labels/vocabulary'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { AppliedOverride, CheckDisposition, RepoConfigReadFailureKind, RepoProblem } from '../../shared/repos'
import { applyOverrides, parseOverrides } from './overrides'
import type { EffectiveConfigShape } from './overrides'

/** The port-resolved values `inspect.ts` has already defaulted off the
 *  schema, before any `CLAUDE.md` override applies — this module's only
 *  input besides the raw `labels` map and the repository root. */
export interface PortResolved {
  readonly branches: { readonly integration: string; readonly production: string | null }
  readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
  readonly modules: { readonly approvalGate: boolean; readonly release: boolean; readonly scope: boolean }
  readonly reviewCycleCap: number
  readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
  /** Seeds `sessionRequiredPaths +=` — the port needs this as the append
   *  target; nothing else in the app consumes the resolved list. */
  readonly sessionRequiredPaths: readonly string[]
}

export type EffectiveConfigResult =
  | {
      readonly ok: true
      readonly branches: { readonly integration: string; readonly production: string | null }
      readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
      readonly modules: { readonly approvalGate: boolean; readonly release: boolean; readonly scope: boolean }
      readonly reviewCycleCap: number
      readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
      readonly labelOverrides: Readonly<Partial<Record<LabelKey, string>>>
      readonly checkDispositions: Readonly<Record<string, CheckDisposition>>
      readonly applied: readonly AppliedOverride[]
      readonly refused: readonly { readonly path: string | null; readonly line: string; readonly reason: string }[]
    }
  | { readonly ok: false; readonly problem: Extract<RepoProblem, { readonly kind: 'effective-config-unreadable' }> }

/** The single job key under `jobs:` in `.github/workflows/approval-check.yml`
 *  — the approval-gate's own excused check-run name, derived from the file,
 *  never typed as a literal. A minimal line-based read, not a YAML parser,
 *  mirroring `scripts/port-tick/config.ts`'s own `resolveExcusedCheckName`
 *  byte-for-byte (same two-space-indent assumption, same regex), pinned
 *  against it by `scripts/checks/desktop-registry.ts`. Moved here from
 *  `inspect.ts` unchanged (#300). */
export function parseExcusedCheckName(text: string): string | null {
  const jobsIdx = text.indexOf('\njobs:')
  if (jobsIdx === -1) return null
  const after = text.slice(jobsIdx + '\njobs:'.length)
  const m = /\n {2}([A-Za-z0-9_-]+):/.exec(after)
  return m?.[1] ?? null
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Builds the dotted-path shape `overrides.ts` reads and writes against —
 *  `labels` maps every `LABEL_KEYS` entry to a non-blank `rawLabels[key]`,
 *  else the default name, so an override's `portDefault` reads the real port
 *  value rather than `undefined`. */
export function toShape(portResolved: PortResolved, rawLabels: Readonly<Record<string, unknown>>): EffectiveConfigShape {
  const labels: Record<string, string> = {}
  for (const def of LABEL_DEFAULTS) {
    const raw = rawLabels[def.key]
    labels[def.key] = isNonBlankString(raw) ? raw : def.name
  }
  return {
    integration: portResolved.branches.integration,
    production: portResolved.branches.production,
    labels,
    models: { ...portResolved.models },
    modules: { ...portResolved.modules },
    reviewCycleCap: portResolved.reviewCycleCap,
    concurrency: { sharedFiles: [...portResolved.concurrency.sharedFiles], overlapThreshold: portResolved.concurrency.overlapThreshold },
    sessionRequiredPaths: [...portResolved.sessionRequiredPaths],
  }
}

/** The inverse of `toShape` for the fields `ResolvedRepoConfig` itself
 *  carries — `labels` folds into the label vocabulary separately
 *  (`labelOverridesOf`), and `sessionRequiredPaths` has no consumer here. */
export function fromShape(shape: EffectiveConfigShape): Pick<EffectiveConfigResult & { readonly ok: true }, 'branches' | 'models' | 'modules' | 'reviewCycleCap' | 'concurrency'> {
  return {
    branches: { integration: shape.integration, production: shape.production },
    models: { ...shape.models },
    modules: { ...shape.modules },
    reviewCycleCap: shape.reviewCycleCap,
    concurrency: { sharedFiles: [...shape.concurrency.sharedFiles], overlapThreshold: shape.concurrency.overlapThreshold },
  }
}

/** The `labels.<key>` entries among `applied`, as `{ [key]: value }` —
 *  `resolveVocabulary`'s own `overrides` input. */
export function labelOverridesOf(applied: readonly AppliedOverride[]): Partial<Record<LabelKey, string>> {
  const out: Partial<Record<LabelKey, string>> = {}
  const knownKeys = LABEL_KEYS as readonly string[]
  for (const a of applied) {
    if (!a.path.startsWith('labels.') || typeof a.value !== 'string') continue
    const key = a.path.slice('labels.'.length)
    if (knownKeys.includes(key)) out[key as LabelKey] = a.value
  }
  return out
}

/** Ported from `loadConfig`'s own loop: the approval-gate name first, as
 *  `infrastructure`/`approval-gate`; then each applied `checks.<name>`, as
 *  its value/`CLAUDE.md`, a later entry overwriting the same key exactly as
 *  the cockpit's does — the two sources cannot otherwise collide, since the
 *  workflow file's job key is never a name an operator would also write by
 *  hand into the block for the same disposition value. */
export function foldDispositions(excusedCheck: string | null, applied: readonly AppliedOverride[]): Record<string, CheckDisposition> {
  const out: Record<string, CheckDisposition> = {}
  if (excusedCheck !== null) out[excusedCheck] = { disposition: 'infrastructure', source: 'approval-gate' }
  for (const a of applied) {
    if (!a.path.startsWith('checks.')) continue
    if (a.value !== 'blocking' && a.value !== 'infrastructure') continue
    out[a.path.slice('checks.'.length)] = { disposition: a.value, source: 'CLAUDE.md' }
  }
  return out
}

/** Resolves one repository's effective config: `CLAUDE.md` overrides folded
 *  over `portResolved`, then the approval-gate excusal and every applied
 *  `checks.*` entry folded into one disposition map. Fails closed on actions
 *  (`effective-config-unreadable`) when either `CLAUDE.md` or
 *  `.github/workflows/approval-check.yml` exists but cannot be read — an
 *  unread override can rename a label or change a gate, so this app refuses
 *  to act on the repository rather than silently running on port defaults
 *  for a block it could not actually read. Absent file (`not-found`) is not
 *  a failure: every category simply runs on the port value. */
export async function resolveEffectiveConfig(root: string, portResolved: PortResolved, rawLabels: Readonly<Record<string, unknown>>): Promise<EffectiveConfigResult> {
  const claudeMdResult = await readTextFile(pathOps.join(root, 'CLAUDE.md'))
  let claudeMdText = ''
  if (claudeMdResult.ok) {
    claudeMdText = claudeMdResult.value
  } else if (claudeMdResult.kind !== 'not-found') {
    return { ok: false, problem: { kind: 'effective-config-unreadable', file: 'CLAUDE.md', reason: claudeMdResult.kind as RepoConfigReadFailureKind, message: claudeMdResult.message } }
  }

  const parsed = parseOverrides(claudeMdText)
  const { cfg, applied, refused } = applyOverrides(toShape(portResolved, rawLabels), parsed, { labelKeys: [...LABEL_KEYS] })

  let excusedCheckName: string | null = null
  if (cfg.modules.approvalGate) {
    const workflowResult = await readTextFile(pathOps.join(root, '.github', 'workflows', 'approval-check.yml'))
    if (workflowResult.ok) {
      excusedCheckName = parseExcusedCheckName(workflowResult.value)
    } else if (workflowResult.kind !== 'not-found') {
      return {
        ok: false,
        problem: { kind: 'effective-config-unreadable', file: '.github/workflows/approval-check.yml', reason: workflowResult.kind as RepoConfigReadFailureKind, message: workflowResult.message },
      }
    }
  }

  return {
    ok: true,
    ...fromShape(cfg),
    labelOverrides: labelOverridesOf(applied),
    checkDispositions: foldDispositions(excusedCheckName, applied),
    applied,
    refused,
  }
}

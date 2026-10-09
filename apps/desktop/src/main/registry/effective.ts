// Resolves a repository's *effective* config: the port-resolved values `inspect.ts` built, with a root `CLAUDE.md` `port-overrides` block folded on top. Composition only — `overrides.ts` does the actual parsing and validation.
import { pathOps } from '../platform/paths'
import { readTextFile } from '../platform/files'
import { LABEL_DEFAULTS } from '../../shared/labels/defaults'
import { LABEL_KEYS } from '../../shared/labels/vocabulary'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { AppliedOverride, CheckDisposition, RepoConfigReadFailureKind, RepoProblem } from '../../shared/repos'
import { applyOverrides, parseOverrides } from '../../../../../scripts/port-tick/overrides'
import type { EffectiveConfigShape } from '../../../../../scripts/port-tick/overrides'

/** Values `inspect.ts` has already defaulted off the schema, before any `CLAUDE.md` override applies. */
export interface PortResolved {
  readonly branches: { readonly integration: string; readonly production: string | null }
  readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
  readonly modules: { readonly approvalGate: boolean; readonly release: boolean; readonly scope: boolean }
  readonly reviewCycleCap: number
  readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
  /** Seeds `sessionRequiredPaths +=` — nothing else in the app consumes the resolved list. */
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

/** The single job key under `jobs:` in `.github/workflows/approval-check.yml`, derived from the file, never typed as a literal. A minimal line-based read, not a YAML parser. */
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

/** `labels` maps every `LABEL_KEYS` entry to a non-blank `rawLabels[key]`, else the default name, so an override's `portDefault` reads the real value. */
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

/** The inverse of `toShape` — `labels` folds into the label vocabulary separately, and `sessionRequiredPaths` has no consumer here. */
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

/** The approval-gate name first, then each applied `checks.<name>`, a later entry overwriting the same key exactly as the cockpit does. */
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

/** Fails closed (`effective-config-unreadable`) when a config file exists but cannot be read, since an unread override could rename a label or change a gate. Absent file is not a failure. */
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

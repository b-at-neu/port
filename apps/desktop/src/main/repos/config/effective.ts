// Resolves a repository's *effective* config: the port-resolved values `inspect.ts` built, with the default branch's `CLAUDE.md` `port-overrides` block folded on top. Composition only — `overrides.ts` does the actual parsing and validation.
import { DISPLAY_DEFAULTS, DISPLAY_KEYS } from '@/utils/labels/display'
import type { DisplayKey } from '@/utils/labels/display'
import type { AppliedOverride, CheckDisposition, RepoProblem } from '@/utils/repos'
import { applyOverrides, parseOverrides } from '@/utils/pipeline/overrides'
import type { EffectiveConfigShape } from '@/utils/pipeline/overrides'

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

/** A file read from the repository's default branch at `origin/HEAD`, the ref stage agents read. */
export type RefRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly kind: 'ref-unreadable' | 'not-found' | 'unreadable'; readonly message: string }

export type RefReader = (relPath: string) => Promise<RefRead>

type EffectiveConfigResult =
  | {
      readonly ok: true
      readonly branches: { readonly integration: string; readonly production: string | null }
      readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
      readonly modules: { readonly approvalGate: boolean; readonly release: boolean; readonly scope: boolean }
      readonly reviewCycleCap: number
      readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
      readonly sessionRequiredPaths: readonly string[]
      /** The applied `labels.<key>`/`states.<key>` overrides. */
      readonly displayOverrides: Readonly<Partial<Record<DisplayKey, string>>>
      readonly checkDispositions: Readonly<Record<string, CheckDisposition>>
      readonly applied: readonly AppliedOverride[]
      readonly refused: readonly { readonly path: string | null; readonly line: string; readonly reason: string }[]
    }
  | { readonly ok: false; readonly problem: Extract<RepoProblem, { readonly kind: 'effective-config-unreadable' }> }

/** The single job key under `jobs:` in `.github/workflows/approval-check.yml` (and `artifacts.yml`), derived from the file, never typed as a literal. A minimal line-based read, not a YAML parser. */
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

/** The two maps the vocabulary splits across: `labels` holds the marker and the gate, `states` the rest. */
const MARKER_KEYS: readonly DisplayKey[] = ['port', 'needsYou']
const APP_STATE_KEYS: readonly DisplayKey[] = DISPLAY_KEYS.filter((key) => !MARKER_KEYS.includes(key))

function namesOf(keys: readonly string[], defaults: readonly { readonly key: string; readonly name: string }[], raw: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const def of defaults) {
    if (!keys.includes(def.key)) continue
    const value = raw[def.key]
    out[def.key] = isNonBlankString(value) ? value : def.name
  }
  return out
}

/** Each map holds its keys' non-blank `raw` value, else the default name, so an override's `portDefault` reads the real value. */
export function toShape(portResolved: PortResolved, rawLabels: Readonly<Record<string, unknown>>, rawStates: Readonly<Record<string, unknown>> = {}): EffectiveConfigShape {
  const labels = namesOf(MARKER_KEYS, DISPLAY_DEFAULTS, rawLabels)
  const states = namesOf(APP_STATE_KEYS, DISPLAY_DEFAULTS, rawStates)
  return {
    integration: portResolved.branches.integration,
    production: portResolved.branches.production,
    labels,
    states,
    models: { ...portResolved.models },
    modules: { ...portResolved.modules },
    reviewCycleCap: portResolved.reviewCycleCap,
    concurrency: { sharedFiles: [...portResolved.concurrency.sharedFiles], overlapThreshold: portResolved.concurrency.overlapThreshold },
    sessionRequiredPaths: [...portResolved.sessionRequiredPaths],
  }
}

/** The inverse of `toShape` — `labels` and `states` fold into the display vocabulary separately. */
export function fromShape(
  shape: EffectiveConfigShape,
): Pick<EffectiveConfigResult & { readonly ok: true }, 'branches' | 'models' | 'modules' | 'reviewCycleCap' | 'concurrency' | 'sessionRequiredPaths'> {
  return {
    branches: { integration: shape.integration, production: shape.production },
    models: { ...shape.models },
    modules: { ...shape.modules },
    reviewCycleCap: shape.reviewCycleCap,
    concurrency: { sharedFiles: [...shape.concurrency.sharedFiles], overlapThreshold: shape.concurrency.overlapThreshold },
    sessionRequiredPaths: [...shape.sessionRequiredPaths],
  }
}

/** The `labels.<key>`/`states.<key>` entries among `applied` that name a display key, as `{ [key]: value }` — `resolveDisplayVocabulary`'s own `overrides` input. */
export function displayOverridesOf(applied: readonly AppliedOverride[]): Partial<Record<DisplayKey, string>> {
  const out: Partial<Record<DisplayKey, string>> = {}
  const known = DISPLAY_KEYS as readonly string[]
  for (const a of applied) {
    if (typeof a.value !== 'string') continue
    const prefix = a.path.startsWith('labels.') ? 'labels.' : a.path.startsWith('states.') ? 'states.' : null
    if (prefix === null) continue
    const key = a.path.slice(prefix.length)
    if (known.includes(key)) out[key as DisplayKey] = a.value
  }
  return out
}

/** The approval-gate name, then the history-derived artifacts audit, then each applied `checks.<name>`, a later entry overwriting the same key exactly as the cockpit does. */
export function foldDispositions(excusedCheck: string | null, historyCheck: string | null, applied: readonly AppliedOverride[]): Record<string, CheckDisposition> {
  const out: Record<string, CheckDisposition> = {}
  if (excusedCheck !== null) out[excusedCheck] = { disposition: 'infrastructure', source: 'approval-gate' }
  if (historyCheck !== null) out[historyCheck] = { disposition: 'blocking', source: 'artifacts-audit' }
  for (const a of applied) {
    if (!a.path.startsWith('checks.')) continue
    if (a.value !== 'blocking' && a.value !== 'infrastructure') continue
    out[a.path.slice('checks.'.length)] = { disposition: a.value, source: 'CLAUDE.md' }
  }
  return out
}

/** Fails closed (`effective-config-unreadable`) when a config file exists but cannot be read, since an unread override could rename a label or change a gate. Absent file is not a failure. */
export async function resolveEffectiveConfig(
  read: RefReader,
  portResolved: PortResolved,
  rawLabels: Readonly<Record<string, unknown>>,
  rawStates: Readonly<Record<string, unknown>>,
): Promise<EffectiveConfigResult> {
  const claudeMdResult = await read('CLAUDE.md')
  let claudeMdText = ''
  if (claudeMdResult.ok) {
    claudeMdText = claudeMdResult.text
  } else if (claudeMdResult.kind !== 'not-found') {
    return { ok: false, problem: { kind: 'effective-config-unreadable', file: 'CLAUDE.md', reason: 'io', message: claudeMdResult.message } }
  }

  const parsed = parseOverrides(claudeMdText)
  const keys = { labelKeys: [...MARKER_KEYS], stateKeys: [...APP_STATE_KEYS] }
  const { cfg, applied, refused } = applyOverrides(toShape(portResolved, rawLabels, rawStates), parsed, keys)

  let excusedCheckName: string | null = null
  if (cfg.modules.approvalGate) {
    const workflowResult = await read('.github/workflows/approval-check.yml')
    if (workflowResult.ok) {
      excusedCheckName = parseExcusedCheckName(workflowResult.text)
    } else if (workflowResult.kind !== 'not-found') {
      return { ok: false, problem: { kind: 'effective-config-unreadable', file: '.github/workflows/approval-check.yml', reason: 'io', message: workflowResult.message } }
    }
  }

  let historyCheckName: string | null = null
  const artifactsResult = await read('.github/workflows/artifacts.yml')
  if (artifactsResult.ok) {
    historyCheckName = parseExcusedCheckName(artifactsResult.text)
  } else if (artifactsResult.kind !== 'not-found') {
    return { ok: false, problem: { kind: 'effective-config-unreadable', file: '.github/workflows/artifacts.yml', reason: 'io', message: artifactsResult.message } }
  }

  return {
    ok: true,
    ...fromShape(cfg),
    displayOverrides: displayOverridesOf(applied),
    checkDispositions: foldDispositions(excusedCheckName, historyCheckName, applied),
    applied,
    refused,
  }
}

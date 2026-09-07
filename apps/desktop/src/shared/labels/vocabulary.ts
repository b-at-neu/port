import { LABEL_DEFAULTS, type LabelModule, type LabelRole } from './defaults'

/**
 * Every label key `plugins/port/templates/labels.json` defines, in the
 * template's own order. TypeScript widens a JSON import's string values to
 * `string`, so this literal union cannot be derived from that import — it is
 * hand-maintained and cross-checked against the template both directions by
 * `vocabulary.test.ts` and `scripts/checks.mjs`'s `desktop-label-defaults`
 * guard, the same idiom `shared/ipc.ts`'s `IPC_CHANNELS` uses for the IPC map.
 */
export const LABEL_KEYS = [
  'marker',
  'autoPlan',
  'ready',
  'planChangesRequested',
  'planApproved',
  'readyForReview',
  'needsRevision',
  'refreshBranch',
  'planning',
  'inProgress',
  'reviewing',
  'revising',
  'refreshing',
  'planReview',
  'blocked',
  'needsHuman',
  'prOpened',
  'approved',
] as const

export type LabelKey = (typeof LABEL_KEYS)[number]

export type LabelSource = 'config' | 'default'

export interface ResolvedLabel {
  readonly key: LabelKey
  readonly name: string
  readonly source: LabelSource
  readonly module: LabelModule
  /** Off `labels.json`'s own `role` field (#79 Decision 1) — never re-derived
   *  from a second key→stage table. An overridden *name* never changes the
   *  role; it is a property of the key, not of what an operator calls it. */
  readonly role: LabelRole
}

/**
 * A config-authoring mistake, never a thrown error — every one of these is
 * something a human should see and fix, not an exception a resolver raises.
 */
export type VocabularyProblem =
  | { readonly kind: 'unknown-key'; readonly key: string }
  | { readonly kind: 'invalid-override'; readonly key: LabelKey; readonly value: unknown }
  | { readonly kind: 'collision'; readonly name: string; readonly keys: readonly LabelKey[] }
  | { readonly kind: 'case-mismatch'; readonly key: LabelKey; readonly resolved: string; readonly actual: string }

export interface LabelVocabulary {
  readonly labels: readonly ResolvedLabel[]
  readonly disabled: readonly LabelKey[]
  readonly problems: readonly VocabularyProblem[]
}

export interface VocabularyInput {
  readonly labels?: Readonly<Record<string, unknown>>
  readonly modules?: Readonly<Record<string, boolean>>
}

/**
 * A fetch that failed is a distinct value, never an empty array — "no labels
 * came back" and "the repository has no labels" must not collapse into one
 * state. Mirrors the discriminated-result shape `shared/ipc.ts` establishes.
 */
export type RepoLabels = { readonly ok: true; readonly names: readonly string[] } | { readonly ok: false; readonly reason: string }

export type VocabularyVerdict = 'verified' | 'partial' | 'mis-resolved' | 'unverified'

export interface VocabularyReport {
  readonly verdict: VocabularyVerdict
  readonly present: readonly string[]
  readonly missing: readonly string[]
  readonly problems: readonly VocabularyProblem[]
  readonly repoLabels: RepoLabels
  readonly unverifiedReason?: string
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Pure: no filesystem, no `gh`, no config discovery. Reading a config is
 * #74's job; calling GitHub is #76's. `input.labels` values are `unknown` —
 * a config on disk is never runtime-validated before it reaches here, so
 * every override is treated as untrusted and narrowed on the spot.
 */
export function resolveVocabulary(input: VocabularyInput): LabelVocabulary {
  const labelsInput = input.labels ?? {}
  const modulesInput = input.modules ?? {}
  const problems: VocabularyProblem[] = []
  const disabled: LabelKey[] = []
  const resolved: ResolvedLabel[] = []

  const knownKeys = LABEL_KEYS as readonly string[]
  for (const key of Object.keys(labelsInput)) {
    if (!knownKeys.includes(key)) {
      problems.push({ kind: 'unknown-key', key })
    }
  }

  for (const def of LABEL_DEFAULTS) {
    if (def.module !== 'core' && modulesInput[def.module] !== true) {
      disabled.push(def.key)
      continue
    }

    const override = labelsInput[def.key]
    if (override === undefined) {
      resolved.push({ key: def.key, name: def.name, source: 'default', module: def.module, role: def.role })
    } else if (isNonBlankString(override)) {
      resolved.push({ key: def.key, name: override, source: 'config', module: def.module, role: def.role })
    } else {
      problems.push({ kind: 'invalid-override', key: def.key, value: override })
      resolved.push({ key: def.key, name: def.name, source: 'default', module: def.module, role: def.role })
    }
  }

  const keysByName = new Map<string, LabelKey[]>()
  for (const label of resolved) {
    const keys = keysByName.get(label.name)
    if (keys) keys.push(label.key)
    else keysByName.set(label.name, [label.key])
  }
  for (const [name, keys] of keysByName) {
    if (keys.length > 1) problems.push({ kind: 'collision', name, keys })
  }

  return { labels: resolved, disabled, problems }
}

/**
 * Returns `undefined` for a module-disabled key — consumers go through this
 * rather than indexing `labels` directly, so "this label does not apply to
 * this repository" is a case the type system forces them to handle.
 */
export function labelName(vocabulary: LabelVocabulary, key: LabelKey): string | undefined {
  return vocabulary.labels.find((label) => label.key === key)?.name
}

/**
 * Pure over an already-fetched result — see `RepoLabels`. Compares names
 * case-insensitively with `toLowerCase()` (not `toLocaleLowerCase`, which
 * maps dotted/dotless `I` under a Turkish locale) because GitHub matches
 * label names case-insensitively; a case-only difference must report as
 * present-with-a-mismatch, never as missing.
 */
export function verifyVocabulary(vocabulary: LabelVocabulary, repoLabels: RepoLabels): VocabularyReport {
  if (!repoLabels.ok) {
    return {
      verdict: 'unverified',
      present: [],
      missing: [],
      problems: vocabulary.problems,
      repoLabels,
      unverifiedReason: repoLabels.reason,
    }
  }

  const actualByLower = new Map<string, string>()
  for (const name of repoLabels.names) {
    actualByLower.set(name.toLowerCase(), name)
  }

  const present: string[] = []
  const missing: string[] = []
  const problems: VocabularyProblem[] = [...vocabulary.problems]

  for (const label of vocabulary.labels) {
    const actual = actualByLower.get(label.name.toLowerCase())
    if (actual === undefined) {
      missing.push(label.name)
      continue
    }
    present.push(label.name)
    if (actual !== label.name) {
      problems.push({ kind: 'case-mismatch', key: label.key, resolved: label.name, actual })
    }
  }

  const verdict: VocabularyVerdict =
    missing.length === 0 ? 'verified' : present.length === 0 && vocabulary.labels.length > 0 ? 'mis-resolved' : 'partial'

  return { verdict, present, missing, problems, repoLabels }
}

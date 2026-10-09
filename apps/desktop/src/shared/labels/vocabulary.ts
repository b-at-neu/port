import { LABEL_DEFAULTS, type LabelModule, type LabelRole } from './defaults'

/** Every label key the shipped template defines; hand-maintained since a JSON import's string values widen to `string` and cannot derive this union. */
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

/** `'CLAUDE.md'` is an override from the repository's own `port-overrides` block; it wins over `'config'`, which wins over `'default'`. */
export type LabelSource = 'config' | 'default' | 'CLAUDE.md'

export interface ResolvedLabel {
  readonly key: LabelKey
  readonly name: string
  readonly source: LabelSource
  readonly module: LabelModule
  /** Off `labels.json`'s own `role` field. An overridden name never changes the role; it is a property of the key, not of what an operator calls it. */
  readonly role: LabelRole
}

/** A config-authoring mistake, never a thrown error. */
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
  /** `CLAUDE.md` overrides — an entry here wins over the same key in `labels`, with `source: 'CLAUDE.md'`. Already validated, so no second check runs here. */
  readonly overrides?: Readonly<Partial<Record<LabelKey, string>>>
}

/** A fetch that failed is a distinct value, never an empty array — "no labels came back" and "the repository has no labels" must not collapse into one state. */
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

/** Pure: no filesystem, no `gh`, no config discovery. `input.labels` values are `unknown` and narrowed on the spot, since nothing validates them before this call. */
export function resolveVocabulary(input: VocabularyInput): LabelVocabulary {
  const labelsInput = input.labels ?? {}
  const modulesInput = input.modules ?? {}
  const claudeMdOverrides = input.overrides ?? {}
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

    // A CLAUDE.md override wins over port.config.json's labels map; already validated, so no second check here.
    const claudeMdOverride = claudeMdOverrides[def.key]
    if (claudeMdOverride !== undefined) {
      resolved.push({ key: def.key, name: claudeMdOverride, source: 'CLAUDE.md', module: def.module, role: def.role })
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

/** Returns `undefined` for a module-disabled key, so "this label does not apply here" is a case the type system forces callers to handle. */
export function labelName(vocabulary: LabelVocabulary, key: LabelKey): string | undefined {
  return vocabulary.labels.find((label) => label.key === key)?.name
}

/** Compares names with `toLowerCase()`, not `toLocaleLowerCase` (which maps dotted/dotless `I` under a Turkish locale), since GitHub matches case-insensitively. */
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

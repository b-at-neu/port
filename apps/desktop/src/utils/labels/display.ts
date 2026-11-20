// The display vocabulary: the seven labels the app shows on GitHub. The stage keys the app decides by stay in `defaults.ts`.
import template from './labels.json'
import type { LabelSource, VerifiableVocabulary, VocabularyProblem } from '@/utils/labels/vocabulary'

/** Every key `labels.json` defines; hand-maintained since a JSON import's string values widen to `string`, and pinned against the file by the `labels-display` check. */
export const DISPLAY_KEYS = ['port', 'needsYou', 'planning', 'implementing', 'reviewing', 'revising', 'approved'] as const
export type DisplayKey = (typeof DISPLAY_KEYS)[number]

/** The keys `labels` may override; every other display key belongs to `states`. */
const LABEL_MAP_KEYS: readonly DisplayKey[] = ['port', 'needsYou']
const STATE_MAP_KEYS: readonly DisplayKey[] = ['planning', 'implementing', 'reviewing', 'revising', 'approved']

const DISPLAY_ROLES = ['marker', 'in-flight', 'gate', 'terminal'] as const
export type DisplayRole = (typeof DISPLAY_ROLES)[number]

const DISPLAY_PALETTES = ['plan', 'implement', 'review', 'revise', 'needs-you', 'done'] as const
export type DisplayPalette = (typeof DISPLAY_PALETTES)[number]

export interface DisplayDefault {
  readonly key: DisplayKey
  readonly name: string
  readonly color: string
  readonly role: DisplayRole
  readonly palette: DisplayPalette | null
  readonly description: string
}

function isDisplayDefault(entry: unknown): entry is DisplayDefault {
  if (typeof entry !== 'object' || entry === null) return false
  const candidate = entry as Record<string, unknown>
  const keys = DISPLAY_KEYS as readonly string[]
  const roles = DISPLAY_ROLES as readonly string[]
  const palettes = DISPLAY_PALETTES as readonly string[]
  return (
    typeof candidate.key === 'string' &&
    keys.includes(candidate.key) &&
    typeof candidate.name === 'string' &&
    typeof candidate.color === 'string' &&
    typeof candidate.role === 'string' &&
    roles.includes(candidate.role) &&
    (candidate.palette === null || (typeof candidate.palette === 'string' && palettes.includes(candidate.palette))) &&
    typeof candidate.description === 'string'
  )
}

export const DISPLAY_DEFAULTS: readonly DisplayDefault[] = (template.labels as unknown[]).filter(isDisplayDefault)

export interface DisplayLabel {
  readonly key: DisplayKey
  readonly name: string
  readonly source: LabelSource
  readonly role: DisplayRole
  readonly palette: DisplayPalette | null
}

export interface DisplayVocabulary extends VerifiableVocabulary {
  readonly labels: readonly DisplayLabel[]
}

export interface DisplayVocabularyInput {
  readonly labels?: Readonly<Record<string, unknown>>
  readonly states?: Readonly<Record<string, unknown>>
  /** `CLAUDE.md` overrides, keyed by display key — already validated against the same key sets, and winning over the config maps. */
  readonly overrides?: Readonly<Partial<Record<DisplayKey, string>>>
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function unknownKeysOf(map: Readonly<Record<string, unknown>>, allowed: readonly DisplayKey[], prefix: string): VocabularyProblem[] {
  const known = allowed as readonly string[]
  return Object.keys(map)
    .filter((key) => !known.includes(key))
    .map((key) => ({ kind: 'unknown-key', key: `${prefix}${key}` }))
}

/** Pure, like `resolveVocabulary`. Casing is kept verbatim: `verifyVocabulary` compares case-insensitively, as GitHub does. */
export function resolveDisplayVocabulary(input: DisplayVocabularyInput): DisplayVocabulary {
  const labelsInput = input.labels ?? {}
  const statesInput = input.states ?? {}
  const overrides = input.overrides ?? {}
  const problems: VocabularyProblem[] = [...unknownKeysOf(labelsInput, LABEL_MAP_KEYS, ''), ...unknownKeysOf(statesInput, STATE_MAP_KEYS, 'states.')]
  const resolved: DisplayLabel[] = []

  for (const def of DISPLAY_DEFAULTS) {
    const shared = { key: def.key, role: def.role, palette: def.palette }
    const claudeMdOverride = overrides[def.key]
    if (claudeMdOverride !== undefined) {
      resolved.push({ ...shared, name: claudeMdOverride, source: 'CLAUDE.md' })
      continue
    }
    const map = LABEL_MAP_KEYS.includes(def.key) ? labelsInput : statesInput
    const override = map[def.key]
    if (override === undefined) {
      resolved.push({ ...shared, name: def.name, source: 'default' })
    } else if (isNonBlankString(override)) {
      resolved.push({ ...shared, name: override, source: 'config' })
    } else {
      problems.push({ kind: 'invalid-override', key: def.key, value: override })
      resolved.push({ ...shared, name: def.name, source: 'default' })
    }
  }

  const keysByName = new Map<string, string[]>()
  for (const label of resolved) {
    const lower = label.name.toLowerCase()
    keysByName.set(lower, [...(keysByName.get(lower) ?? []), label.key])
  }
  for (const [name, keys] of keysByName) {
    if (keys.length > 1) problems.push({ kind: 'collision', name, keys })
  }

  return { labels: resolved, problems }
}

/** The part of a resolved repository config that decides which vocabulary the label list is checked against. */
export function verifiableVocabularyOf(config: { readonly appOnly?: boolean; readonly vocabulary: VerifiableVocabulary; readonly displayVocabulary?: VerifiableVocabulary }): VerifiableVocabulary {
  return config.appOnly === true && config.displayVocabulary !== undefined ? config.displayVocabulary : config.vocabulary
}

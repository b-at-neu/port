// Pure: what GitHub should show for a stored item. Nothing here reads a label or touches I/O.
import { fullKeysOf, type StoredItem } from '@/types/pipeline-state'
import type { DisplayKey, DisplayVocabulary } from '@/utils/labels/display'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { labelName, type LabelKey, type LabelVocabulary } from '@/utils/labels/vocabulary'

type DisplayState = 'planning' | 'implementing' | 'reviewing' | 'revising' | 'approved'

const STATE_OF_KEY: Readonly<Partial<Record<LabelKey, DisplayState>>> = {
  ready: 'planning',
  planning: 'planning',
  planReview: 'planning',
  planChangesRequested: 'planning',
  planApproved: 'implementing',
  inProgress: 'implementing',
  blocked: 'implementing',
  readyForReview: 'reviewing',
  reviewing: 'reviewing',
  needsRevision: 'revising',
  revising: 'revising',
  refreshBranch: 'revising',
  refreshing: 'revising',
  approved: 'approved',
}

// Revising wins over approved, so a branch refresh beside `approved` shows as revising.
const PRIORITY: readonly DisplayState[] = ['revising', 'approved', 'reviewing', 'implementing', 'planning']

const NEEDS_YOU_KEYS: readonly LabelKey[] = ['planReview', 'blocked', 'needsHuman']

const REPLACED_BY_APPROVED: ReadonlySet<LabelKey> = new Set(LABEL_DEFAULTS.filter((label) => label.role === 'in-flight' || label.role === 'trigger').map((label) => label.key))

function stateOfKeys(keys: readonly LabelKey[]): DisplayState | null {
  const states = new Set(keys.flatMap((key) => STATE_OF_KEY[key] ?? []))
  return PRIORITY.find((state) => states.has(state)) ?? null
}

/** `needsHuman` alone recovers the state it interrupted from the newest history row that added a mapped key. */
export function displayStateOf(item: StoredItem): DisplayState | null {
  const direct = stateOfKeys(item.keys)
  if (direct !== null) return direct
  if (!item.keys.includes('needsHuman')) return null
  for (const row of [...item.history].reverse()) {
    const recovered = stateOfKeys(row.add)
    if (recovered !== null) return recovered
  }
  return item.kind === 'issue' ? 'planning' : 'reviewing'
}

export function needsYouOf(item: StoredItem): boolean {
  return NEEDS_YOU_KEYS.some((key) => item.keys.includes(key))
}

/** An issue at `prOpened` shows its pull request's state; with no linked pull request in the store it shows implementing. */
export function displayKeysOf(item: StoredItem, linkedPr: StoredItem | null): readonly DisplayKey[] {
  const state = item.kind === 'issue' && item.keys.includes('prOpened') ? (linkedPr === null ? 'implementing' : (displayStateOf(linkedPr) ?? 'implementing')) : displayStateOf(item)
  if (state === null) return ['port']
  const needsYou = needsYouOf(item) || (item.kind === 'issue' && item.keys.includes('prOpened') && linkedPr !== null && needsYouOf(linkedPr))
  return needsYou ? ['port', state, 'needsYou'] : ['port', state]
}

export function legacyKeysOf(item: StoredItem): readonly LabelKey[] {
  return fullKeysOf(item)
}

/** The stored keys a merged item shows: `approved` in place of every in-flight or trigger key. */
export function mergedKeysOf(item: StoredItem): readonly LabelKey[] {
  return [...fullKeysOf(item).filter((key) => !REPLACED_BY_APPROVED.has(key) && key !== 'approved'), 'approved']
}

export function mergedDisplayKeys(): readonly DisplayKey[] {
  return ['port', 'approved']
}

/** The stored pull request that names this issue as its ticket, newest first. */
export function linkedPullRequestOf(items: readonly StoredItem[], issueNumber: number): StoredItem | null {
  const linked = items.filter((item) => item.kind === 'pull-request' && item.issue === issueNumber)
  return linked.reduce<StoredItem | null>((newest, item) => (newest === null || Date.parse(item.updatedAt) > Date.parse(newest.updatedAt) ? item : newest), null)
}

/** The ticket of a stored pull request, only while it still holds `prOpened`. */
export function linkedIssueOf(items: readonly StoredItem[], pr: StoredItem): StoredItem | null {
  if (pr.issue === null) return null
  const issue = items.find((item) => item.kind === 'issue' && item.number === pr.issue)
  return issue !== undefined && issue.keys.includes('prOpened') ? issue : null
}

/** The ticket number a `<n>-…` branch names, `null` for any other branch. */
export function issueNumberOfBranch(headRefName: string | null): number | null {
  const match = /^(\d+)-/.exec(headRefName ?? '')
  return match === null ? null : Number(match[1])
}

export function displayNamesOf(vocabulary: DisplayVocabulary, keys: readonly DisplayKey[]): readonly string[] {
  return keys.flatMap((key) => vocabulary.labels.find((label) => label.key === key)?.name ?? [])
}

export function allDisplayNames(vocabulary: DisplayVocabulary): readonly string[] {
  return vocabulary.labels.map((label) => label.name)
}

export function legacyNamesOf(vocabulary: LabelVocabulary, keys: readonly LabelKey[]): readonly string[] {
  return keys.flatMap((key) => labelName(vocabulary, key) ?? [])
}

export function allLegacyNames(vocabulary: LabelVocabulary): readonly string[] {
  return vocabulary.labels.map((label) => label.name)
}

/** Adds the desired names the item lacks and removes every other vocabulary name it carries; a name outside `all` is never touched. */
export function mirrorDiff(desired: readonly string[], all: readonly string[], observed: readonly string[]): { readonly addNames: readonly string[]; readonly removeNames: readonly string[] } {
  const lower = (name: string): string => name.toLowerCase()
  const present = new Set(observed.map(lower))
  const wanted = new Set(desired.map(lower))
  const addNames = desired.filter((name, index) => !present.has(lower(name)) && desired.findIndex((other) => lower(other) === lower(name)) === index)
  const removeNames = all.filter((name, index) => !wanted.has(lower(name)) && present.has(lower(name)) && all.findIndex((other) => lower(other) === lower(name)) === index)
  return { addNames, removeNames }
}

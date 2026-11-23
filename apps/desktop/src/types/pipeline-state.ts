// Contract for the app-owned pipeline state store: plain JSON, safe to cross the state worker boundary.
import type { ReadyEntry } from '@/types/actions'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { PipelineItemKind } from '@/types/github'
import type { RepositoryState } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'

export interface StoredHistoryRow {
  readonly at: string
  readonly action: string
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly actor: string | null
}

/** The last label mirror write that did not land, kept until a retry does. */
export interface MirrorFailure {
  readonly at: string
  readonly outcome: WriteOutcome
}

/** `keys` holds the role-bearing stage keys; `marked` and `autoPlan` carry the two marker keys. */
export interface StoredItem {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly keys: readonly LabelKey[]
  readonly marked: boolean
  readonly autoPlan: boolean
  readonly claimedAt: string | null
  readonly reviewCycles: number
  readonly history: readonly StoredHistoryRow[]
  readonly updatedAt: string
  /** A pull request's ticket, `null` for an issue or an unlinked pull request. */
  readonly issue: number | null
  readonly mirrorFailure: MirrorFailure | null
}

export interface RepoRecord {
  readonly seededAt: string
  /** Keyed `issue:<n>` / `pull-request:<n>`. */
  readonly items: Readonly<Record<string, StoredItem>>
}

export interface PipelineStateFile {
  readonly version: 1
  readonly repositories: Readonly<Record<string, RepoRecord>>
}

/** The store's label names for one item: `null` for an unseeded repository, `[]` for an untracked item in a seeded one. */
export type StateLabelsReader = (repoId: RepoId, kind: PipelineItemKind, number: number, vocabulary: LabelVocabulary) => readonly string[] | null

/** Every stored key, markers included. */
export function fullKeysOf(item: Pick<StoredItem, 'keys' | 'marked' | 'autoPlan'>): readonly LabelKey[] {
  return [...(item.marked ? (['marker'] as const) : []), ...(item.autoPlan ? (['autoPlan'] as const) : []), ...item.keys]
}

/** `unseeded` means the repository has no record yet and reseeds once from labels; `store` means the stored items decide stage. */
export type PipelineView = { readonly kind: 'unseeded' } | { readonly kind: 'store'; readonly items: readonly StoredItem[] }

/** One mirror write with no transition: `merged` writes the terminal state, `state` whatever the store holds. */
export interface MirrorItemParams {
  readonly entry: ReadyEntry
  readonly ref: { readonly kind: PipelineItemKind; readonly number: number }
  readonly action: string
  readonly auditDir: string
  readonly mode: 'state' | 'merged'
}

/** A tracked item and the full key set (markers included) it carries in the store. */
export interface TrackedRef {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly keys: readonly LabelKey[]
}

export interface TransitionInput {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly expect: { readonly present: readonly LabelKey[]; readonly absent: readonly LabelKey[] }
  readonly action: string
  readonly at: string
  readonly actor: string | null
  /** Sets a pull request's ticket while it is still unknown. */
  readonly issue: number | null
}

export type TransitionResult = { readonly ok: true; readonly item: StoredItem; readonly changed: boolean } | { readonly ok: false; readonly reason: 'precondition-failed' }

export interface PipelineStateStore {
  /** Settles once the file has been read; every read and transition waits on it. */
  readonly ready: Promise<void>
  readonly view: (repoId: RepoId) => PipelineView
  readonly tracked: (repoId: RepoId) => readonly TrackedRef[] | null
  readonly seed: (repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>) => Promise<void>
  readonly prune: (repoId: RepoId, closed: readonly number[]) => Promise<void>
  readonly recordMirror: (repoId: RepoId, ref: { readonly kind: PipelineItemKind; readonly number: number }, failure: MirrorFailure | null) => Promise<void>
  readonly transition: (repoId: RepoId, ref: { readonly kind: PipelineItemKind; readonly number: number }, input: TransitionInput) => Promise<StoreTransitionResult>
}

export type StoreTransitionResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'precondition-failed' }
  | { readonly ok: false; readonly reason: 'persist-failed'; readonly message: string }

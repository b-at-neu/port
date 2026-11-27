// Pure: the store's tickets as the display label names they show, for readers that take a label list.
import { displayOf } from '@/main/pipeline/state/display'
import { displayNamesOf } from '@/main/pipeline/state/mirror'
import type { PipelineItemKind } from '@/types/github'
import type { PipelineStateStore, PipelineView } from '@/types/pipeline-state'
import type { DisplayVocabulary } from '@/utils/labels/display'
import type { RepoId } from '@/utils/repos'

/** What an action on an unseeded repository tells the operator. */
export const UNSEEDED_MESSAGE = "port hasn't loaded this repository's pipeline state yet"

/** `null` for an unseeded repository, which has no store to read; `[]` for an untracked item in a seeded one. */
export function stateLabelsOf(view: PipelineView, kind: PipelineItemKind, number: number, vocabulary: DisplayVocabulary): readonly string[] | null {
  if (view.kind === 'unseeded') return null
  const item = view.items.find((candidate) => candidate.kind === kind && candidate.number === number)
  return item === undefined ? [] : displayNamesOf(vocabulary, displayOf(item.ticket))
}

/** `stateLabelsOf` over the record store's current view. */
export function storedLabels(ctx: { readonly stores: { readonly pipelineState: Pick<PipelineStateStore, 'view'> } }, repoId: RepoId, kind: PipelineItemKind, number: number, vocabulary: DisplayVocabulary): readonly string[] | null {
  return stateLabelsOf(ctx.stores.pipelineState.view(repoId), kind, number, vocabulary)
}

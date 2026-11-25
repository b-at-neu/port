// Pure: the store's keys as configured label names, for readers that take a label list.
import type { PipelineItemKind } from '@/types/github'
import { fullKeysOf, type PipelineStateStore, type PipelineView } from '@/types/pipeline-state'
import { labelName, type LabelVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

/** What an action on an unseeded repository tells the operator. */
export const UNSEEDED_MESSAGE = "port hasn't loaded this repository's pipeline state yet"

/** `null` for an unseeded repository, which has no store to read; `[]` for an untracked item in a seeded one. */
export function stateLabelsOf(view: PipelineView, kind: PipelineItemKind, number: number, vocabulary: LabelVocabulary): readonly string[] | null {
  if (view.kind === 'unseeded') return null
  const item = view.items.find((candidate) => candidate.kind === kind && candidate.number === number)
  if (item === undefined) return []
  return fullKeysOf(item).flatMap((key) => {
    const name = labelName(vocabulary, key)
    return name === undefined ? [] : [name]
  })
}

/** `stateLabelsOf` over the record store's current view. */
export function storedLabels(ctx: { readonly stores: { readonly pipelineState: Pick<PipelineStateStore, 'view'> } }, repoId: RepoId, kind: PipelineItemKind, number: number, vocabulary: LabelVocabulary): readonly string[] | null {
  return stateLabelsOf(ctx.stores.pipelineState.view(repoId), kind, number, vocabulary)
}

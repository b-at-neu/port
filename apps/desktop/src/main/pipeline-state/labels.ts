// Pure: the store's keys as configured label names, for readers that still take a label list.
import type { PipelineItemKind } from '@/types/github'
import { fullKeysOf, type PipelineView } from '@/types/pipeline-state'
import { labelName, type LabelVocabulary } from '@/utils/labels/vocabulary'

/** `null` under a labels view, so the caller keeps GitHub's labels; `[]` for an untracked item under a store view. */
export function stateLabelsOf(view: PipelineView, kind: PipelineItemKind, number: number, vocabulary: LabelVocabulary): readonly string[] | null {
  if (view.kind === 'labels') return null
  const item = view.items.find((candidate) => candidate.kind === kind && candidate.number === number)
  if (item === undefined) return []
  return fullKeysOf(item).flatMap((key) => {
    const name = labelName(vocabulary, key)
    return name === undefined ? [] : [name]
  })
}

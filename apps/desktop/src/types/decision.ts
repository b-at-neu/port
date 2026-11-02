import type { ReviseContext, UnblockContext } from '@/types/actions'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

export type DecisionState =
  | { readonly step: 'closed' }
  | {
      readonly step: 'confirm-unblock'
      readonly repoId: RepoId
      readonly number: number
      readonly expectedStage: LabelKey | null
      readonly context: UnblockContext
      /** Chosen letter per decision id, seeded from each decision's recommendation. */
      readonly picks: Readonly<Record<string, string>>
    }
  | { readonly step: 'confirm-revise'; readonly repoId: RepoId; readonly number: number; readonly expectedStage: LabelKey | null; readonly context: ReviseContext; readonly text: string }

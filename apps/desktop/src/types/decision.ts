import type { GrantContext, ReviseContext, UnblockContext } from '@/types/actions'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

export type DecisionTarget = {
  readonly repoId: RepoId
  readonly number: number
  readonly expectedStage: LabelKey | null
} & (
  | { readonly decision: 'unblock'; readonly context: UnblockContext }
  | { readonly decision: 'revise'; readonly context: ReviseContext }
  | { readonly decision: 'grant'; readonly context: GrantContext }
)

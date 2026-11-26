import type { GrantContext, ReviseContext, UnblockContext } from '@/types/actions'
import type { TicketView } from '@/utils/pipeline/stages'
import type { RepoId } from '@/utils/repos'

export type DecisionTarget = {
  readonly repoId: RepoId
  readonly number: number
  readonly expected: TicketView | null
} & (
  | { readonly decision: 'unblock'; readonly context: UnblockContext }
  | { readonly decision: 'revise'; readonly context: ReviseContext }
  | { readonly decision: 'grant'; readonly context: GrantContext }
)

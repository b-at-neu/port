import type { SessionRecord } from '@/types/sessions'

/** `history/model.ts`'s `groupHistory` output, consumed by `history/screen.tsx`. */
export interface HistoryGroups {
  readonly pinned: readonly SessionRecord[]
  readonly recent: readonly SessionRecord[]
  readonly archived: readonly SessionRecord[]
}

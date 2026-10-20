// The one visible-items read: the screen, the sidebar count, the palette and the per-repo dots all
// go through it, so a dismissed or auto-cleared item can never disagree between them.
import { useIpcQuery } from '@/renderer/data/query'
import { needsYouItems } from '@/renderer/board/needs-you'
import { useDismissed, visibleItems } from '@/renderer/needs-you/dismissed'
import type { NeedsYouItem } from '@/types/board'

export function useNeedsYouItems(): readonly NeedsYouItem[] {
  const snapshot = useIpcQuery('board:snapshot')
  const sessions = useIpcQuery('session:list')
  const dismissed = useDismissed()
  if (snapshot.data === undefined) return []
  return visibleItems(needsYouItems(snapshot.data, new Date(), sessions.data ?? []), dismissed)
}

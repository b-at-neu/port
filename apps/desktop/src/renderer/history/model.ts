// Groups History's filtered session list into Pinned/Recent/Archived — pure, keeps the incoming `idleMs` order within each group.
import type { SessionMarks } from '@/types/hosting'
import type { SessionRecord } from '@/types/sessions'
import type { HistoryGroups } from '@/types/history'

/** Archived wins over pinned: an archived-and-pinned session goes to `archived` (it still carries its pin glyph there) and is hidden unless `showArchived` is set. */
export function groupHistory(sessions: readonly SessionRecord[], marks: SessionMarks, showArchived: boolean): HistoryGroups {
  const pinned: SessionRecord[] = []
  const recent: SessionRecord[] = []
  const archived: SessionRecord[] = []

  for (const session of sessions) {
    const isArchived = marks.archived.includes(session.sessionId)
    const isPinned = marks.pinned.includes(session.sessionId)
    if (isArchived) {
      if (showArchived) archived.push(session)
      continue
    }
    if (isPinned) pinned.push(session)
    else recent.push(session)
  }

  return { pinned, recent, archived }
}

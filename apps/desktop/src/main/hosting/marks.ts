// Pin and archive marks: an insertion-ordered, capped set per kind. Idempotent — setting
// an id to its current state is a no-op rather than moving it to the end.
import type { SessionMarks } from '../../shared/hosting/types'

/** Per-kind cap; the oldest id is dropped to make room for a new one. */
export const MARKS_LIMIT = 500

export interface SessionMarksTracker {
  current(): SessionMarks
  set(kind: 'pinned' | 'archived', sessionId: string, on: boolean): SessionMarks
}

function withMark(ids: readonly string[], sessionId: string, on: boolean): readonly string[] {
  const has = ids.includes(sessionId)
  if (on === has) return ids
  if (!on) return ids.filter((id) => id !== sessionId)
  const next = [...ids, sessionId]
  return next.length > MARKS_LIMIT ? next.slice(next.length - MARKS_LIMIT) : next
}

export function createSessionMarks(initial: SessionMarks): SessionMarksTracker {
  let pinned = initial.pinned
  let archived = initial.archived

  return {
    current() {
      return { pinned, archived }
    },
    set(kind, sessionId, on) {
      if (kind === 'pinned') pinned = withMark(pinned, sessionId, on)
      else archived = withMark(archived, sessionId, on)
      return { pinned, archived }
    },
  }
}

// The Board's remembered List/Board choice and collapsed kanban lanes, persisted in localStorage; a missing or malformed value reads as the list and every lane expanded.
import type { KeyValueStorage } from '@/types/storage'
import type { BoardView } from '@/types/router'
import type { RepoId } from '@/utils/repos'
import { readIdSet, writeIdSet } from '@/renderer/lib/id-set-storage'

const STORAGE_KEY = 'port.boardView.v1'
const COLLAPSED_LANES_KEY = 'port.boardCollapsedLanes.v1'

export function readBoardView(storage: KeyValueStorage = window.localStorage): BoardView {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    return parsed === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}

export function setBoardView(view: BoardView, storage: KeyValueStorage = window.localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(view))
  } catch {
    // Best-effort only — a full or blocked localStorage loses the preference, never the app.
  }
}

export function readBoardCollapsedLanes(storage: KeyValueStorage = window.localStorage): ReadonlySet<RepoId> {
  return readIdSet(storage, COLLAPSED_LANES_KEY)
}

export function setBoardLaneCollapsed(repoId: RepoId, collapsed: boolean, storage: KeyValueStorage = window.localStorage): void {
  const next = new Set(readIdSet(storage, COLLAPSED_LANES_KEY))
  if (collapsed) next.add(repoId)
  else next.delete(repoId)
  writeIdSet(storage, COLLAPSED_LANES_KEY, next)
}

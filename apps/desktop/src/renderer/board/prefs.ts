// The Board's remembered List/Board choice, persisted in localStorage; a missing or malformed value reads as the list.
import type { KeyValueStorage } from '@/types/storage'
import type { BoardView } from '@/types/router'

const STORAGE_KEY = 'port.boardView.v1'

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

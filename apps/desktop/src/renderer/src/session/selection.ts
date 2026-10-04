// #103: the selected session key — read by the permission dialog
// (`permission/controller.ts`) to flag a prompt from a session other than
// the one on screen. `session/controller.ts` is the only writer; anything
// else only reads through `selectedSession()`/`onSelectionChange()`.
import type { SessionKey } from '../../../shared/hosting/types'

let current: SessionKey | null = null
const listeners = new Set<() => void>()

export function selectedSession(): SessionKey | null {
  return current
}

export function setSelectedSession(key: SessionKey | null): void {
  if (current === key) return
  current = key
  for (const listener of listeners) listener()
}

export function onSelectionChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

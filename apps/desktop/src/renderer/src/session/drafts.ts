// The composer's per-session draft text, kept outside React so switching
// sessions never loses what was half-typed in another one.
import { useSyncExternalStore } from 'react'
import type { SessionKey } from '../../../shared/hosting/types'

const drafts = new Map<SessionKey, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function draftFor(key: SessionKey): string {
  return drafts.get(key) ?? ''
}

export function setDraft(key: SessionKey, value: string): void {
  if (value === '') drafts.delete(key)
  else drafts.set(key, value)
  notify()
}

export function clearDraft(key: SessionKey): void {
  if (!drafts.has(key)) return
  drafts.delete(key)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDraft(key: SessionKey | null): string {
  return useSyncExternalStore(subscribe, () => (key === null ? '' : draftFor(key)))
}

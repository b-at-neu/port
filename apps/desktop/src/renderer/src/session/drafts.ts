// The composer's per-session draft, kept outside React so switching sessions
// never loses what was half-typed (or half-attached) in another one.
import { useSyncExternalStore } from 'react'
import type { SessionKey } from '../../../shared/hosting/types'
import type { ComposerAttachment } from '../../../shared/hosting/attachments'

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

// The draft's own attachment chips, same lifetime rule as the text above — its own map, since every existing text caller only ever wants the text.
const draftAttachments = new Map<SessionKey, readonly ComposerAttachment[]>()

// Stable "no attachments" reference — useSyncExternalStore needs the same value back when nothing changed.
const NO_ATTACHMENTS: readonly ComposerAttachment[] = []

export function draftAttachmentsFor(key: SessionKey): readonly ComposerAttachment[] {
  return draftAttachments.get(key) ?? NO_ATTACHMENTS
}

export function setDraftAttachments(key: SessionKey, value: readonly ComposerAttachment[]): void {
  if (value.length === 0) draftAttachments.delete(key)
  else draftAttachments.set(key, value)
  notify()
}

export function clearDraftAttachments(key: SessionKey): void {
  if (!draftAttachments.has(key)) return
  draftAttachments.delete(key)
  notify()
}

export function useDraftAttachments(key: SessionKey | null): readonly ComposerAttachment[] {
  return useSyncExternalStore(subscribe, () => (key === null ? NO_ATTACHMENTS : draftAttachmentsFor(key)))
}

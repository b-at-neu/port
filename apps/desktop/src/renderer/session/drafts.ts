// The composer's per-session draft, kept outside React so switching sessions
// never loses what was half-typed (or half-attached) in another one.
import { useSyncExternalStore } from 'react'
import { createStore } from '@/renderer/lib/store'
import type { Store } from '@/renderer/lib/store'
import type { SessionKey } from '@/types/hosting'
import type { ComposerAttachment } from '@/utils/hosting/attachments'

const NO_ATTACHMENTS: readonly ComposerAttachment[] = []

const drafts = createStore<ReadonlyMap<SessionKey, string>>(new Map())
const draftAttachments = createStore<ReadonlyMap<SessionKey, readonly ComposerAttachment[]>>(new Map())

/** A `null` value removes the key; removing an absent key changes nothing and notifies nobody. */
function put<V>(store: Store<ReadonlyMap<SessionKey, V>>, key: SessionKey, value: V | null): void {
  if (value === null && !store.get().has(key)) return
  const next = new Map(store.get())
  if (value === null) next.delete(key)
  else next.set(key, value)
  store.set(next)
}

export function draftFor(key: SessionKey): string {
  return drafts.get().get(key) ?? ''
}

export function setDraft(key: SessionKey, value: string): void {
  put(drafts, key, value === '' ? null : value)
}

export function clearDraft(key: SessionKey): void {
  put(drafts, key, null)
}

export function useDraft(key: SessionKey | null): string {
  return useSyncExternalStore(drafts.subscribe, () => (key === null ? '' : draftFor(key)))
}

export function draftAttachmentsFor(key: SessionKey): readonly ComposerAttachment[] {
  return draftAttachments.get().get(key) ?? NO_ATTACHMENTS
}

export function setDraftAttachments(key: SessionKey, value: readonly ComposerAttachment[]): void {
  put(draftAttachments, key, value.length === 0 ? null : value)
}

export function clearDraftAttachments(key: SessionKey): void {
  put(draftAttachments, key, null)
}

export function useDraftAttachments(key: SessionKey | null): readonly ComposerAttachment[] {
  return useSyncExternalStore(draftAttachments.subscribe, () => (key === null ? NO_ATTACHMENTS : draftAttachmentsFor(key)))
}

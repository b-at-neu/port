// One external store per `sessionKey` — attach, re-attach, buffering and
// revision gaps. `createEntriesRegistry` is the injectable, directly-testable factory; `useSessionEntries` is its one app-wide hook.
import { useCallback, useSyncExternalStore } from 'react'
import type { LiveBlock, SessionAttachResult, SessionEntriesDelta, SessionKey } from '../../../shared/hosting/types'
import type { EntryPatch, TranscriptEntry } from '../../../shared/sessions/transcript'
import { accept, drainBuffered } from './sequence'
import { sharedSubscriptions } from '../data/subscriptions'
import type { Subscriptions } from '../data/subscriptions'

export interface SessionEntriesSnapshot {
  readonly entries: readonly TranscriptEntry[]
  readonly firstIndex: number
  readonly live: LiveBlock | null
  readonly attaching: boolean
  readonly gone: boolean
}

const EMPTY_SNAPSHOT: SessionEntriesSnapshot = { entries: [], firstIndex: 0, live: null, attaching: false, gone: false }

interface EntriesState {
  entries: TranscriptEntry[]
  firstIndex: number
  live: LiveBlock | null
  lastRevision: number
  buffered: SessionEntriesDelta[]
  attaching: boolean
  gone: boolean
  generation: number
  refCount: number
  snapshot: SessionEntriesSnapshot
  readonly listeners: Set<() => void>
}

function freshState(): EntriesState {
  return { entries: [], firstIndex: 0, live: null, lastRevision: 0, buffered: [], attaching: false, gone: false, generation: 0, refCount: 0, snapshot: EMPTY_SNAPSHOT, listeners: new Set() }
}

function applyPartial(state: EntriesState, delta: SessionEntriesDelta): void {
  if (delta.partial === null) return
  if (delta.partial.op === 'clear') {
    state.live = null
  } else if (state.live !== null && state.live.blockId === delta.partial.blockId) {
    state.live = { ...state.live, text: state.live.text + delta.partial.text }
  } else {
    state.live = { blockId: delta.partial.blockId, kind: delta.partial.kind, text: delta.partial.text, omittedChars: 0 }
  }
}

function applyPatches(state: EntriesState, patches: readonly EntryPatch[]): void {
  for (const patch of patches) {
    const relative = patch.index - state.firstIndex
    if (relative < 0 || relative >= state.entries.length) continue
    state.entries[relative] = patch.entry
  }
}

function ingestDelta(state: EntriesState, delta: SessionEntriesDelta): void {
  if (delta.appended.length > 0) state.entries = [...state.entries, ...delta.appended]
  applyPatches(state, delta.patched)
  applyPartial(state, delta)
}

export interface EntriesRegistryDeps {
  readonly sessionAttach: (sessionKey: SessionKey) => Promise<SessionAttachResult>
}

export interface EntriesRegistry {
  getSnapshot(key: SessionKey): SessionEntriesSnapshot
  subscribe(key: SessionKey, listener: () => void): () => void
  handlePush(delta: SessionEntriesDelta): void
  reattach(key: SessionKey): Promise<void>
  forget(key: SessionKey): void
}

/** Injectable so `entries-store.test.ts` can drive gap/buffer/supersede with
 *  a fake, deterministic `sessionAttach` — no real IPC, no timers. */
export function createEntriesRegistry(deps: EntriesRegistryDeps): EntriesRegistry {
  const stores = new Map<SessionKey, EntriesState>()

  function stateFor(key: SessionKey): EntriesState {
    let state = stores.get(key)
    if (state === undefined) {
      state = freshState()
      stores.set(key, state)
    }
    return state
  }

  function notify(state: EntriesState): void {
    state.snapshot = { entries: state.entries, firstIndex: state.firstIndex, live: state.live, attaching: state.attaching, gone: state.gone }
    for (const listener of state.listeners) listener()
  }

  async function reattach(key: SessionKey): Promise<void> {
    const state = stateFor(key)
    const generation = ++state.generation
    state.attaching = true
    notify(state)
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await deps.sessionAttach(key)
        if (state.generation !== generation) return
        if (!result.ok) {
          state.gone = true
          state.attaching = false
          notify(state)
          return
        }

        state.entries = [...result.entries]
        state.firstIndex = result.firstIndex
        state.live = result.partial
        state.lastRevision = result.revision
        state.gone = false

        const toDrain = state.buffered
        state.buffered = []
        const drained = drainBuffered(result.revision, toDrain)
        if (drained.kind === 'gap') continue

        for (const delta of drained.deltas) {
          ingestDelta(state, delta)
          state.lastRevision = delta.revision
        }
        state.attaching = false
        notify(state)
        return
      }
    } catch (error) {
      console.error('Failed to attach to the hosted session', error)
    } finally {
      if (state.generation === generation && state.attaching) {
        state.attaching = false
        notify(state)
      }
    }
  }

  function handlePush(delta: SessionEntriesDelta): void {
    const state = stores.get(delta.sessionKey)
    if (state === undefined) return
    if (state.attaching) {
      state.buffered.push(delta)
      return
    }
    const outcome = accept(state.lastRevision, delta)
    if (outcome === 'apply') {
      ingestDelta(state, delta)
      state.lastRevision = delta.revision
      notify(state)
    } else if (outcome === 'gap') {
      void reattach(delta.sessionKey)
    }
  }

  return {
    getSnapshot: (key) => stateFor(key).snapshot,
    handlePush,
    reattach,
    forget: (key) => {
      stores.delete(key)
    },
    subscribe(key, listener) {
      const state = stateFor(key)
      state.listeners.add(listener)
      state.refCount += 1
      if (state.refCount === 1 && state.entries.length === 0 && !state.attaching && !state.gone) void reattach(key)
      return () => {
        state.listeners.delete(listener)
        state.refCount -= 1
      }
    },
  }
}

let shared: EntriesRegistry | null = null
let pushAttached = false

function sharedRegistry(subscriptions: Subscriptions): EntriesRegistry {
  shared ??= createEntriesRegistry({
    sessionAttach: (sessionKey) => window.port.sessionAttach({ sessionKey }),
  })
  if (!pushAttached) {
    pushAttached = true
    subscriptions.subscribe('session:entries', (delta) => shared?.handlePush(delta))
  }
  return shared
}

export function useSessionEntries(key: SessionKey | null): SessionEntriesSnapshot {
  const registry = sharedRegistry(sharedSubscriptions())
  const subscribe = useCallback((onChange: () => void) => (key === null ? () => {} : registry.subscribe(key, onChange)), [registry, key])
  const getSnapshot = useCallback(() => (key === null ? EMPTY_SNAPSHOT : registry.getSnapshot(key)), [registry, key])

  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Drops a session's in-memory entries once it is dismissed — called by
 *  `session/actions.ts`'s `dismiss`. */
export function forgetSessionEntries(key: SessionKey): void {
  shared?.forget(key)
}

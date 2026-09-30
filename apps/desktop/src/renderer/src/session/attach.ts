// #103: one session's own attach/re-attach machinery and per-session state
// shape — split out of session/controller.ts to stay under the file-size
// limit (ENGINEERING §7). `reattachSession`'s callbacks are always
// `controller.ts`'s own closures over its `sessions` map and `screen`, so
// this module stays free of any dependency back on the controller.
import type { HostedSessionSnapshot, SessionEntriesDelta, SessionKey } from '../../../shared/hosting/types'
import { createEntryList } from '../entry-list'
import type { EntryList } from '../entry-list'
import { accept, drainBuffered } from './sequence'
import type { SessionRefs } from './view'

export interface PerSessionState {
  entryList: EntryList | null
  lastRevision: number
  buffered: SessionEntriesDelta[]
  attaching: boolean
  composerValue: string
  sendError: string | null
  sessionGone: boolean
  closeConfirming: boolean
  interruptNoteValue: string | null
  windowNoteVisible: boolean
}

export function freshPerSessionState(): PerSessionState {
  return {
    entryList: null,
    lastRevision: 0,
    buffered: [],
    attaching: false,
    composerValue: '',
    sendError: null,
    sessionGone: false,
    closeConfirming: false,
    interruptNoteValue: null,
    windowNoteVisible: false,
  }
}

function applyPartial(entryList: EntryList, delta: SessionEntriesDelta): void {
  if (delta.partial === null) return
  if (delta.partial.op === 'clear') {
    entryList.setLive(null)
  } else {
    entryList.setLive({ blockId: delta.partial.blockId, kind: delta.partial.kind, text: '', omittedChars: 0 })
    entryList.appendLive(delta.partial.text)
  }
}

function ingestDelta(entryList: EntryList, delta: SessionEntriesDelta): void {
  entryList.append(delta.appended)
  entryList.patch(delta.patched)
  applyPartial(entryList, delta)
}

/** Applies one `session:entries` push to `state`, buffering it instead while
 *  a `reattachSession` round trip for the same session is in flight, and
 *  triggering `onGap` (always a fresh `reattachSession`) on a missed
 *  revision rather than applying the rest out of order. A push for any
 *  session other than `currentKey` is dropped — only the selected session's
 *  entry list is live in the DOM. */
export function applyEntriesDelta(state: PerSessionState, currentKey: SessionKey | null, delta: SessionEntriesDelta, onGap: () => void): void {
  if (delta.sessionKey !== currentKey) return
  if (state.attaching) {
    state.buffered.push(delta)
    return
  }
  const outcome = accept(state.lastRevision, delta)
  if (outcome === 'apply') {
    if (state.entryList !== null) ingestDelta(state.entryList, delta)
    state.lastRevision = delta.revision
  } else if (outcome === 'gap') {
    onGap()
  }
}

function buildEntryList(refs: SessionRefs, firstIndex: number): EntryList {
  refs.list.textContent = ''
  return createEntryList({ list: refs.list, jumpButton: refs.jumpButton, baseIndex: firstIndex, focusIndex: null })
}

export interface ReattachDeps {
  readonly refs: SessionRefs
  readonly sessionKey: SessionKey
  readonly state: PerSessionState
  /** True once this round trip has been superseded — a later `switchTo`'s
   *  own token, or the selection having moved elsewhere while it was in
   *  flight. */
  readonly superseded: () => boolean
  readonly onSnapshot: (snapshot: HostedSessionSnapshot) => void
  readonly onGone: () => void
  readonly draw: () => void
}

/** Attaches (or re-attaches) to `deps.sessionKey`, looping internally on a
 *  drained gap rather than recursing. Every check against `superseded()`
 *  happens right after the one `await` in this function, so a stale round
 *  trip never renders into a session the operator has since switched away
 *  from. */
export async function reattachSession(deps: ReattachDeps): Promise<void> {
  const { state } = deps
  state.attaching = true
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await window.port.sessionAttach({ sessionKey: deps.sessionKey })
      if (deps.superseded()) return
      if (!result.ok) {
        deps.onGone()
        deps.draw()
        return
      }
      deps.onSnapshot(result.snapshot)
      state.entryList?.dispose()
      state.entryList = buildEntryList(deps.refs, result.firstIndex)
      state.windowNoteVisible = result.firstIndex > 0
      state.entryList.append(result.entries)
      if (result.partial !== null) state.entryList.setLive(result.partial)
      state.lastRevision = result.revision

      const toDrain = state.buffered
      state.buffered = []
      const drained = drainBuffered(result.revision, toDrain)
      if (drained.kind === 'gap') continue

      for (const delta of drained.deltas) {
        ingestDelta(state.entryList, delta)
        state.lastRevision = delta.revision
      }
      deps.draw()
      return
    }
  } catch (error) {
    console.error('Failed to attach to the hosted session', error)
  } finally {
    state.attaching = false
  }
}

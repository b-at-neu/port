// #219: the Session tab's own state machine, IPC wiring, and keyboard
// handling — the same module-level-closure idiom `permission/controller.ts`
// and `transcript-tail.ts` already establish (no framework, no class). Owns
// exactly one live session in the UI at a time (#103 owns switching between
// several); a start while the current one is not `ended` is refused
// client-side with a banner rather than silently discarding it.
import type { RepoId } from '../../../shared/repos'
import type { HostedSessionSnapshot, SessionEntriesDelta, SessionKey } from '../../../shared/hosting/types'
import { buildSessionView, renderSessionChrome } from './view'
import type { SessionRefs, SessionScreenState } from './view'
import { createEntryList } from '../entry-list'
import type { EntryList } from '../entry-list'
import { accept, drainBuffered } from './sequence'
import { BUSY_BANNER, SEND_FAILED_UNKNOWN_SESSION, SEND_FAILED_UNREACHABLE, START_UNREACHABLE, interruptNote, startFailureCopy } from './copy'

let refs: SessionRefs | null = null
let showCallback: (() => void) | null = null

let currentSessionKey: SessionKey | null = null
let repoLabel = ''
let latestSnapshot: HostedSessionSnapshot | null = null

let entryList: EntryList | null = null
let lastRevision = 0
let buffered: SessionEntriesDelta[] = []
let attaching = false

let screen: SessionScreenState = { kind: 'empty' }
let composerValue = ''
let sendError: string | null = null
let closeConfirming = false
let interruptNoteValue: string | null = null
let windowNoteVisible = false
let busyBanner: string | null = null

/** Builds the 'live' screen from every field this controller tracks — the
 *  one place that shape is assembled, called wherever any of those fields
 *  changes while a snapshot is already known. Every other screen kind
 *  (`empty`, `reconnecting`, `starting`, `start-failed`) is assigned
 *  directly by the function whose own action caused it, never derived here —
 *  `draw()` only ever paints whatever `screen` currently holds. */
function liveScreen(snapshot: HostedSessionSnapshot): SessionScreenState {
  return { kind: 'live', snapshot, repoLabel, sendError, closeConfirming, interruptNote: interruptNoteValue, windowNoteVisible, composerValue, busyBanner }
}

function draw(): void {
  if (refs === null) return
  renderSessionChrome(refs, screen)
}

function applyPartial(delta: SessionEntriesDelta): void {
  if (entryList === null) return
  if (delta.partial === null) return
  if (delta.partial.op === 'clear') {
    entryList.setLive(null)
  } else {
    entryList.setLive({ blockId: delta.partial.blockId, kind: delta.partial.kind, text: '', omittedChars: 0 })
    entryList.appendLive(delta.partial.text)
  }
}

function ingestDelta(delta: SessionEntriesDelta): void {
  if (entryList === null) return
  entryList.append(delta.appended)
  entryList.patch(delta.patched)
  applyPartial(delta)
}

function onEntriesPush(delta: SessionEntriesDelta): void {
  if (delta.sessionKey !== currentSessionKey) return
  if (attaching) {
    buffered.push(delta)
    return
  }
  const outcome = accept(lastRevision, delta)
  if (outcome === 'apply') {
    ingestDelta(delta)
    lastRevision = delta.revision
  } else if (outcome === 'gap') {
    // A push was missed entirely — re-attach and re-render rather than
    // apply the rest out of order.
    void reattach()
  }
  // 'stale' -- a duplicate or a replay of something already applied; nothing
  // to do.
}

function onStatusPush(snapshot: HostedSessionSnapshot): void {
  if (snapshot.sessionKey !== currentSessionKey) return
  latestSnapshot = snapshot
  if (snapshot.phase !== 'ended') closeConfirming = false
  screen = liveScreen(snapshot)
  draw()
}

function buildEntryList(firstIndex: number): void {
  if (refs === null) return
  entryList?.dispose()
  refs.list.textContent = ''
  entryList = createEntryList({ list: refs.list, jumpButton: refs.jumpButton, baseIndex: firstIndex, focusIndex: null })
}

/** Attaches (or re-attaches) to `currentSessionKey`, looping internally on a
 *  drained gap rather than recursing — `attaching` must stay `true` for the
 *  whole of that retry, and a recursive call's own `finally` would clear the
 *  flag out from under the call that triggered it. Every `session:entries`
 *  push that lands while this runs is buffered (`onEntriesPush`), never
 *  applied out of order against a window this call has not finished
 *  building. */
async function reattach(): Promise<void> {
  const sessionKey = currentSessionKey
  if (sessionKey === null) return
  attaching = true
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await window.port.sessionAttach({ sessionKey })
      if (sessionKey !== currentSessionKey) return // superseded while this round trip was in flight
      if (!result.ok) {
        currentSessionKey = null
        latestSnapshot = null
        entryList?.dispose()
        entryList = null
        screen = { kind: 'empty' }
        draw()
        return
      }
      latestSnapshot = result.snapshot
      windowNoteVisible = result.firstIndex > 0
      buildEntryList(result.firstIndex)
      entryList?.append(result.entries)
      if (result.partial !== null) entryList?.setLive(result.partial)
      lastRevision = result.revision

      const toDrain = buffered
      buffered = []
      const drained = drainBuffered(result.revision, toDrain)
      if (drained.kind === 'gap') continue // one more push was missed while draining -- attach again, fresh

      for (const delta of drained.deltas) {
        ingestDelta(delta)
        lastRevision = delta.revision
      }
      screen = liveScreen(result.snapshot)
      draw()
      return
    }
  } catch (error) {
    console.error('Failed to attach to the hosted session', error)
  } finally {
    attaching = false
  }
}

function focusComposer(): void {
  refs?.composerTextarea.focus()
}

async function startSession(repoId: RepoId, label: string): Promise<void> {
  if (latestSnapshot !== null && latestSnapshot.phase !== 'ended') {
    busyBanner = BUSY_BANNER
    screen = liveScreen(latestSnapshot)
    draw()
    return
  }
  busyBanner = null
  repoLabel = label
  currentSessionKey = null
  latestSnapshot = null
  entryList?.dispose()
  entryList = null
  screen = { kind: 'starting', repoLabel: label }
  draw()

  try {
    const result = await window.port.sessionStart({ repoId, mode: { kind: 'fresh' } })
    if (!result.ok) {
      screen = { kind: 'start-failed', ...startFailureCopy(result) }
      draw()
      return
    }
    currentSessionKey = result.snapshot.sessionKey
    latestSnapshot = result.snapshot
    lastRevision = 0
    buffered = []
    // Always re-attaches rather than trusting this start response's own
    // snapshot directly -- the same code path a boot-time reconnect takes,
    // so buffering is uniform between the two.
    await reattach()
    focusComposer()
    showCallback?.()
  } catch (error) {
    console.error('Failed to reach the main process starting a session', error)
    screen = { kind: 'start-failed', title: 'Could not start a session', body: START_UNREACHABLE, detail: null }
    draw()
  }
}

function handleSessionStartClick(target: HTMLElement): void {
  const repoId = target.dataset.repoId
  const label = target.dataset.repoLabel
  if (repoId === undefined) return
  void startSession(repoId as RepoId, label ?? repoId)
}

/** Redraws the live screen from whatever `latestSnapshot` currently holds —
 *  every composer/banner/confirm field lives at module scope, so this is
 *  the one call every one of their own handlers makes before `draw()`. A
 *  no-op with no live snapshot (nothing to redraw as 'live'). */
function redrawLive(): void {
  if (latestSnapshot === null) return
  screen = liveScreen(latestSnapshot)
  draw()
}

async function send(): Promise<void> {
  if (currentSessionKey === null) return
  const text = composerValue.trim()
  if (text === '') return
  composerValue = ''
  sendError = null
  redrawLive()
  try {
    const result = await window.port.sessionSend({ sessionKey: currentSessionKey, text })
    if (!result.ok) {
      sendError = SEND_FAILED_UNKNOWN_SESSION
      composerValue = text
      redrawLive()
    }
  } catch (error) {
    console.error('Failed to reach the main process sending a message', error)
    sendError = SEND_FAILED_UNREACHABLE
    composerValue = text
    redrawLive()
  }
}

async function stop(): Promise<void> {
  if (currentSessionKey === null) return
  try {
    const result = await window.port.sessionInterrupt({ sessionKey: currentSessionKey })
    interruptNoteValue = result.ok ? interruptNote(result.queuedAfterInterrupt) : null
    redrawLive()
  } catch (error) {
    console.error('Failed to reach the main process interrupting a session', error)
  }
}

async function close(): Promise<void> {
  if (currentSessionKey === null) return
  closeConfirming = false
  try {
    await window.port.sessionClose({ sessionKey: currentSessionKey })
  } catch (error) {
    console.error('Failed to reach the main process closing a session', error)
  }
}

function requestClose(): void {
  if (latestSnapshot === null) return
  if (latestSnapshot.phase === 'streaming' || latestSnapshot.phase === 'interrupting') {
    closeConfirming = true
    redrawLive()
    return
  }
  void close()
}

async function bootFromExistingSession(): Promise<void> {
  try {
    const snapshots = await window.port.sessionList()
    const candidate = [...snapshots].reverse().find((snapshot) => snapshot.phase !== 'ended')
    if (candidate === undefined) return
    currentSessionKey = candidate.sessionKey
    lastRevision = 0
    buffered = []
    screen = { kind: 'reconnecting' }
    draw()
    await reattach()
  } catch (error) {
    console.error('Failed to load the session list at boot', error)
  }
}

function isComposingKeyEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

export interface InitSessionParams {
  readonly show: () => void
}

export function initSession(container: HTMLElement, params: InitSessionParams): void {
  refs = buildSessionView(container)
  showCallback = params.show
  draw()

  window.port.onSessionStatus(onStatusPush)
  window.port.onSessionEntries(onEntriesPush)
  void bootFromExistingSession()

  document.querySelector('#app')?.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const actionable = target.closest<HTMLElement>('[data-action="session-start"]')
    if (actionable !== null) handleSessionStartClick(actionable)
  })

  refs.root.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLElement>('button')
    const action = button?.dataset.action
    if (action === 'session-stop') void stop()
    else if (action === 'session-close') requestClose()
    else if (action === 'session-jump-to-latest') entryList?.jumpToLatest()
    else if (action === 'session-close-confirm') void close()
    else if (action === 'session-close-cancel') {
      closeConfirming = false
      redrawLive()
    } else if (action === 'session-new-from-ended') {
      const repoId = latestSnapshot?.repoId
      if (repoId !== undefined) void startSession(repoId, button?.dataset.repoLabel ?? repoLabel)
    }
  })

  refs.composerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void send()
  })

  refs.composerTextarea.addEventListener('input', () => {
    composerValue = refs?.composerTextarea.value ?? ''
    if (refs !== null) refs.sendButton.disabled = composerValue.trim() === ''
  })

  refs.composerTextarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposingKeyEvent(event)) return
    event.preventDefault()
    void send()
  })
}

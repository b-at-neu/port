// #103: many hosted sessions — the rail lists every one of them; this
// controller owns select/switch/re-attach, per-session composer drafts, and
// the rail/restore/picker wiring on top of #219's single-session base.
// Every start (card, rail picker, restore, or a resume/fork row) selects the
// session it created; `already-open` switches to the returned key instead of
// showing a failure. The same module-level-closure idiom #219 and
// `permission/controller.ts` already establish — no framework, no class.
import type { RepoId } from '../../../shared/repos'
import type { HostedSessionSnapshot, SessionEntriesDelta, SessionKey, SessionStartResult } from '../../../shared/hosting/types'
import { buildSessionView, renderSessionChrome } from './view'
import type { SessionRefs, SessionScreenState } from './view'
import { renderRail } from './rail'
import type { RailProps } from './rail'
import { renderRestore } from './restore'
import type { RestoreBannerState } from './restore'
import { fallbackSelection } from './rail-model'
import { applyEntriesDelta, freshPerSessionState, reattachSession } from './attach'
import type { PerSessionState } from './attach'
import { SEND_FAILED_UNKNOWN_SESSION, SEND_FAILED_UNREACHABLE, START_UNREACHABLE, interruptNote, startFailureCopy } from './copy'
import { handleAgentsToggle, handleArgsCancel, handleArgsInput, handleArgsSubmit, handleCommandRun, openRowCommandName, renderCommands, resetCommandsState } from './commands'
import { onRepoLabelsChange, readyRepos, repoLabelFor, reloadRepoLabels } from '../repo-labels'
import { onSelectionChange, selectedSession, setSelectedSession } from './selection'
import { capacityState, decrementLimit, incrementLimit, loadCapacity } from './capacity-controller'
import { dismissBanner, forget, loadRestoreList, resumeAll, resumeOne, restoreState, toggleReviewing } from './restore-controller'
import { sharedSubscriptions } from '../data/subscriptions'
import { setSelectedSession as persistSelectedSession, shellPrefs } from '../shell/prefs'

let refs: SessionRefs | null = null
let showCallback: (() => void) | null = null

let sessions = new Map<SessionKey, HostedSessionSnapshot>()
const perSession = new Map<SessionKey, PerSessionState>()
let switchToken = 0

let screen: SessionScreenState = { kind: 'empty' }
let newSessionRepoId: RepoId | null = null

function stateFor(key: SessionKey): PerSessionState {
  let state = perSession.get(key)
  if (state === undefined) {
    state = freshPerSessionState()
    perSession.set(key, state)
  }
  return state
}

function snapshotList(): readonly HostedSessionSnapshot[] {
  return [...sessions.values()]
}

function liveScreen(snapshot: HostedSessionSnapshot): SessionScreenState {
  const state = stateFor(snapshot.sessionKey)
  return {
    kind: 'live',
    snapshot,
    repoLabel: repoLabelFor(snapshot.repoId),
    sendError: state.sendError,
    closeConfirming: state.closeConfirming,
    interruptNote: state.interruptNoteValue,
    windowNoteVisible: state.windowNoteVisible,
    composerValue: state.composerValue,
    busyBanner: null,
    sessionGone: state.sessionGone,
  }
}

function draw(): void {
  if (refs === null) return
  renderSessionChrome(refs, screen)
  if (screen.kind === 'live') renderCommands(refs.commandsHost, screen.snapshot)

  const capacity = capacityState()
  const railProps: RailProps = {
    snapshots: snapshotList(),
    selectedKey: selectedSession(),
    limit: capacity.limit,
    ceiling: capacity.ceiling,
    repoLabelFor,
    readyRepos: readyRepos(),
    newSessionRepoId,
    capacityError: capacity.error,
    now: new Date(),
  }
  renderRail(refs.railHost, railProps)

  const restore = restoreState()
  const restoreProps: RestoreBannerState = {
    entries: restore.entries,
    reviewing: restore.reviewing,
    notice: restore.notice,
    repoLabelFor,
    now: new Date(),
  }
  renderRestore(refs.restoreHost, restoreProps)
}

function onEntriesPush(delta: SessionEntriesDelta): void {
  const state = stateFor(delta.sessionKey)
  applyEntriesDelta(state, selectedSession(), delta, () => void reattach(delta.sessionKey))
}

function onStatusPush(snapshot: HostedSessionSnapshot): void {
  const previous = sessions.get(snapshot.sessionKey)
  sessions.set(snapshot.sessionKey, snapshot)
  if (snapshot.phase !== 'ended') stateFor(snapshot.sessionKey).closeConfirming = false

  if (snapshot.sessionKey === selectedSession()) {
    screen = liveScreen(snapshot)
    // `claudeSessionId` arrives after `init` — persisted as soon as known.
    if (snapshot.claudeSessionId !== null && previous?.claudeSessionId !== snapshot.claudeSessionId) persistSelectedSession(snapshot.claudeSessionId)
  }
  draw()
}

/** Attaches (or re-attaches) to `sessionKey` — a switch token comparison
 *  discards a round trip superseded by a later `switchTo`, so an attach that
 *  resolves late never renders into the wrong session. */
async function reattach(sessionKey: SessionKey): Promise<void> {
  if (refs === null) return
  const token = switchToken
  await reattachSession({
    refs,
    sessionKey,
    state: stateFor(sessionKey),
    superseded: () => token !== switchToken || selectedSession() !== sessionKey,
    onSnapshot: (snapshot) => {
      sessions.set(sessionKey, snapshot)
      if (selectedSession() === sessionKey) screen = liveScreen(snapshot)
    },
    onGone: () => {
      sessions.delete(sessionKey)
      if (selectedSession() === sessionKey) {
        setSelectedSession(null)
        screen = { kind: 'empty' }
      }
    },
    draw,
  })
}

function focusComposer(): void {
  refs?.composerTextarea.focus()
}

/** Selects `key`, disposing the previous entry list and re-attaching to the
 *  new one — the composer draft and every other per-session field already
 *  lives keyed by session, so nothing here needs saving or restoring by
 *  hand. */
function switchTo(key: SessionKey): void {
  if (selectedSession() === key) return
  switchToken += 1
  setSelectedSession(key)
  resetCommandsState(key)
  const snapshot = sessions.get(key)
  screen = snapshot !== undefined ? liveScreen(snapshot) : { kind: 'reconnecting' }
  if (snapshot?.claudeSessionId !== null && snapshot?.claudeSessionId !== undefined) persistSelectedSession(snapshot.claudeSessionId)
  draw()
  void reattach(key)
}

function selectAfterStart(snapshot: HostedSessionSnapshot): void {
  sessions.set(snapshot.sessionKey, snapshot)
  switchToken += 1
  setSelectedSession(snapshot.sessionKey)
  resetCommandsState(snapshot.sessionKey)
  screen = liveScreen(snapshot)
  draw()
  void reattach(snapshot.sessionKey)
  focusComposer()
  showCallback?.()
}

function handleStartResult(result: SessionStartResult): void {
  if (result.ok) {
    selectAfterStart(result.snapshot)
    return
  }
  if (result.kind === 'already-open') {
    switchTo(result.sessionKey)
    showCallback?.()
    return
  }
  screen = { kind: 'start-failed', ...startFailureCopy(result) }
  draw()
}

async function startSession(repoId: RepoId, label: string): Promise<void> {
  screen = { kind: 'starting', repoLabel: label }
  draw()
  try {
    const result = await window.port.sessionStart({ repoId, mode: { kind: 'fresh' } })
    handleStartResult(result)
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

function handleRailStart(): void {
  const repoId = newSessionRepoId ?? readyRepos()[0]?.id ?? null
  if (repoId === null) return
  const label = repoLabelFor(repoId)
  void startSession(repoId, label)
}

/** The Transcripts picker's own Resume/Fork buttons (`sessions.ts`) — both
 *  open the Sessions tab on the resulting session. */
async function startFromTranscript(repoId: RepoId, sessionId: string, kind: 'resume' | 'fork'): Promise<void> {
  try {
    const result = await window.port.sessionStart({ repoId, mode: { kind, sessionId } })
    handleStartResult(result)
  } catch (error) {
    console.error('Failed to reach the main process starting a session from a transcript', error)
  }
}

function redrawLive(sessionKey: SessionKey): void {
  const snapshot = sessions.get(sessionKey)
  if (snapshot === undefined || selectedSession() !== sessionKey) return
  screen = liveScreen(snapshot)
  draw()
}

async function send(): Promise<void> {
  const sessionKey = selectedSession()
  if (sessionKey === null) return
  const state = stateFor(sessionKey)
  const text = state.composerValue.trim()
  if (text === '') return
  state.composerValue = ''
  state.sendError = null
  redrawLive(sessionKey)
  try {
    const result = await window.port.sessionSend({ sessionKey, text })
    if (!result.ok) {
      state.sendError = SEND_FAILED_UNKNOWN_SESSION
      state.sessionGone = true
      state.composerValue = text
      redrawLive(sessionKey)
    }
  } catch (error) {
    console.error('Failed to reach the main process sending a message', error)
    state.sendError = SEND_FAILED_UNREACHABLE
    state.composerValue = text
    redrawLive(sessionKey)
  }
}

async function stop(): Promise<void> {
  const sessionKey = selectedSession()
  if (sessionKey === null) return
  const state = stateFor(sessionKey)
  try {
    const result = await window.port.sessionInterrupt({ sessionKey })
    state.interruptNoteValue = result.ok ? interruptNote(result.queuedAfterInterrupt) : null
    redrawLive(sessionKey)
  } catch (error) {
    console.error('Failed to reach the main process interrupting a session', error)
  }
}

async function close(sessionKey: SessionKey): Promise<void> {
  stateFor(sessionKey).closeConfirming = false
  try {
    await window.port.sessionClose({ sessionKey })
  } catch (error) {
    console.error('Failed to reach the main process closing a session', error)
  }
}

function requestClose(): void {
  const sessionKey = selectedSession()
  if (sessionKey === null) return
  const snapshot = sessions.get(sessionKey)
  if (snapshot === undefined) return
  if (snapshot.phase === 'streaming' || snapshot.phase === 'interrupting') {
    stateFor(sessionKey).closeConfirming = true
    redrawLive(sessionKey)
    return
  }
  void close(sessionKey)
}

async function dismiss(sessionKey: SessionKey): Promise<void> {
  try {
    const result = await window.port.sessionDismiss({ sessionKey })
    if (!result.ok) return
    sessions.delete(sessionKey)
    perSession.delete(sessionKey)
    if (selectedSession() === sessionKey) {
      const next = fallbackSelection(snapshotList(), sessionKey)
      if (next === null) {
        switchToken += 1
        setSelectedSession(null)
        screen = { kind: 'empty' }
      } else {
        switchTo(next)
      }
    }
    draw()
  } catch (error) {
    console.error('Failed to reach the main process dismissing a session', error)
  }
}

/** Prefers a live session matching the persisted `claudeSessionId`, never
 *  the session *key* — a `hosted-N` key is reused across relaunches. */
async function bootFromExistingSessions(): Promise<void> {
  try {
    const snapshots = await window.port.sessionList()
    sessions = new Map(snapshots.map((snapshot) => [snapshot.sessionKey, snapshot]))
    const live = [...sessions.values()].reverse().filter((snapshot) => snapshot.phase !== 'ended')
    const savedId = shellPrefs().selectedSession
    const candidate = (savedId !== null ? live.find((snapshot) => snapshot.claudeSessionId === savedId) : undefined) ?? live[0]
    draw()
    if (candidate !== undefined) switchTo(candidate.sessionKey)
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

/** The keyboard map's `Ctrl/Cmd+Tab`/`1…9` source. */
export function liveSessionKeys(): readonly SessionKey[] {
  return snapshotList()
    .filter((snapshot) => snapshot.phase !== 'ended')
    .map((snapshot) => snapshot.sessionKey)
}

/** The sidebar's own session row click — selects and shows the Session screen. */
export function selectSession(key: SessionKey): void {
  switchTo(key)
  showCallback?.()
}

/** The sidebar's **New session** row and the keyboard map's `N`. */
export function startNewSession(repoId: RepoId): void {
  void startSession(repoId, repoLabelFor(repoId))
}

export function initSession(container: HTMLElement, params: InitSessionParams): void {
  refs = buildSessionView(container)
  showCallback = params.show
  draw()

  sharedSubscriptions().subscribe('session:status', onStatusPush)
  sharedSubscriptions().subscribe('session:entries', onEntriesPush)
  onRepoLabelsChange(draw)
  onSelectionChange(draw)
  void reloadRepoLabels()
  void loadCapacity(draw)
  void loadRestoreList(draw)
  void bootFromExistingSessions()

  document.querySelector('#app')?.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const actionable = target.closest<HTMLElement>('[data-action="session-start"]')
    if (actionable !== null) handleSessionStartClick(actionable)
    const resumeRow = target.closest<HTMLElement>('[data-action="session-resume"]')
    if (resumeRow !== null && resumeRow.dataset.sessionId !== undefined) {
      void startFromTranscript(resumeRow.dataset.repoId as RepoId, resumeRow.dataset.sessionId, 'resume')
    }
    const forkRow = target.closest<HTMLElement>('[data-action="session-fork"]')
    if (forkRow !== null && forkRow.dataset.sessionId !== undefined) {
      void startFromTranscript(forkRow.dataset.repoId as RepoId, forkRow.dataset.sessionId, 'fork')
    }
  })

  if (refs === null) return
  const currentRefs = refs

  currentRefs.root.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLElement>('button')
    const action = button?.dataset.action
    const selected = selectedSession()
    if (action === 'session-stop') void stop()
    else if (action === 'session-close') requestClose()
    else if (action === 'session-jump-to-latest') (selected !== null ? stateFor(selected).entryList : null)?.jumpToLatest()
    else if (action === 'session-close-confirm' && selected !== null) void close(selected)
    else if (action === 'session-close-cancel' && selected !== null) {
      stateFor(selected).closeConfirming = false
      redrawLive(selected)
    } else if (action === 'session-new-from-ended') {
      const snapshot = selected !== null ? sessions.get(selected) : undefined
      if (snapshot !== undefined) void startSession(snapshot.repoId, button?.dataset.repoLabel ?? repoLabelFor(snapshot.repoId))
    } else if (action === 'session-command-run') {
      if (selected !== null && button !== null) handleCommandRun(button, selected)
    } else if (action === 'session-command-args-submit') {
      const name = button?.dataset.commandName
      const input = currentRefs.commandsHost.querySelector<HTMLTextAreaElement>('[data-field="session-command-args"]')
      if (selected !== null && name !== undefined && input !== null && input !== undefined) handleArgsSubmit(selected, name, input.value)
    } else if (action === 'session-command-args-cancel') {
      handleArgsCancel()
    } else if (action === 'session-select' && button?.dataset.sessionKey !== undefined) {
      switchTo(button.dataset.sessionKey as SessionKey)
    } else if (action === 'session-dismiss' && button?.dataset.sessionKey !== undefined) {
      void dismiss(button.dataset.sessionKey as SessionKey)
    } else if (action === 'session-new-start') {
      handleRailStart()
    } else if (action === 'session-limit-increment') {
      incrementLimit(draw)
    } else if (action === 'session-limit-decrement') {
      decrementLimit(draw)
    } else if (action === 'session-restore-all') {
      void resumeAll((snapshot) => sessions.set(snapshot.sessionKey, snapshot), draw)
    } else if (action === 'session-restore-review') {
      toggleReviewing(draw)
    } else if (action === 'session-restore-one' && button?.dataset.restoreId !== undefined) {
      void resumeOne(button.dataset.restoreId, { onStarted: selectAfterStart, onAlreadyOpen: switchTo, onChange: draw })
    } else if (action === 'session-restore-forget' && button?.dataset.restoreId !== undefined) {
      void forget(button.dataset.restoreId, draw)
    } else if (action === 'session-restore-dismiss') {
      void dismissBanner(draw)
    }
  })

  currentRefs.root.addEventListener('change', (event) => {
    const target = event.target
    if (target instanceof HTMLSelectElement && target.dataset.field === 'session-new-repo') newSessionRepoId = target.value as RepoId
  })

  currentRefs.commandsHost.addEventListener(
    'toggle',
    (event) => {
      const target = event.target
      if (target instanceof HTMLDetailsElement && target.dataset.action === 'session-agents-toggle') handleAgentsToggle(target.open)
    },
    true,
  )

  currentRefs.commandsHost.addEventListener('input', (event) => {
    const target = event.target
    if (target instanceof HTMLTextAreaElement && target.dataset.field === 'session-command-args') handleArgsInput(target.value)
  })

  currentRefs.commandsHost.addEventListener('keydown', (event) => {
    const target = event.target
    if (!(target instanceof HTMLTextAreaElement) || target.dataset.field !== 'session-command-args') return
    if (event.key === 'Escape') {
      event.preventDefault()
      const commandName = openRowCommandName()
      handleArgsCancel()
      if (commandName !== null) currentRefs.commandsHost.querySelector<HTMLButtonElement>(`[data-action="session-command-run"][data-command-name="${commandName}"]`)?.focus()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || isComposingKeyEvent(event)) return
    event.preventDefault()
    const name = openRowCommandName()
    const selected = selectedSession()
    if (selected !== null && name !== null) handleArgsSubmit(selected, name, target.value)
  })

  currentRefs.composerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void send()
  })

  currentRefs.composerTextarea.addEventListener('input', () => {
    const selected = selectedSession()
    if (selected === null) return
    stateFor(selected).composerValue = currentRefs.composerTextarea.value
    currentRefs.sendButton.disabled = currentRefs.composerTextarea.value.trim() === ''
  })

  currentRefs.composerTextarea.addEventListener('keydown', (event) => {
    // DESIGN §3: Esc stops the turn here first, never bubbling to the
    // keyboard map's own close-pane-or-dialog Esc.
    if (event.key === 'Escape') {
      const selected = selectedSession()
      const snapshot = selected !== null ? sessions.get(selected) : undefined
      if (snapshot !== undefined && (snapshot.phase === 'streaming' || snapshot.phase === 'interrupting')) {
        event.preventDefault()
        event.stopPropagation()
        void stop()
      }
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || isComposingKeyEvent(event)) return
    event.preventDefault()
    void send()
  })
}

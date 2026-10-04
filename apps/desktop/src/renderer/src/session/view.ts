// #219: the session screen's DOM — header (pill, repo, started time, short
// session id, Stop, Close), a banner host, the entry list, and the
// composer. Built once by `buildSessionView()`; `renderSessionChrome()`
// patches it on every redraw, the entry list itself (`entry-list.ts`) is
// mutated in place by `controller.ts` instead of rebuilt. Every node is
// `createElement`/`textContent` only — no `innerHTML`, since a tool result
// or an SDK message is untrusted text.
import type { HostedSessionSnapshot, SessionPhase } from '../../../shared/hosting/types'
import { RUNTIME_COPY } from '../../../shared/runtime/copy'
import {
  CLOSE_BUTTON,
  CLOSE_CONFIRM_NO,
  CLOSE_CONFIRM_PROMPT,
  CLOSE_CONFIRM_YES,
  COMPOSER_HINT,
  EMPTY_HINT,
  EMPTY_TITLE,
  END_COPY,
  NEW_SESSION_BUTTON,
  PHASE_COPY,
  RECONNECTING,
  STOP_BUTTON,
  composerCopy,
  endBody,
  startingCopy,
  windowNote,
} from './copy'

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(label: string, action: string, className: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.textContent = label
  node.dataset.action = action
  return node
}

export interface SessionRefs {
  readonly root: HTMLElement
  /** #103: the rail column's two hosts — `restoreHost` above `railHost`,
   *  rendered by `session/restore.ts`/`session/rail.ts`, never built here. */
  readonly restoreHost: HTMLElement
  readonly railHost: HTMLElement
  readonly pane: HTMLElement
  readonly emptyState: HTMLElement
  readonly live: HTMLElement
  readonly pill: HTMLElement
  readonly headerMeta: HTMLElement
  readonly stopButton: HTMLButtonElement
  readonly closeButton: HTMLButtonElement
  readonly bannerHost: HTMLElement
  readonly list: HTMLElement
  readonly jumpButton: HTMLButtonElement
  readonly endedPanel: HTMLElement
  /** #101: the Pipeline strip's own host — between the entry list and the
   *  composer, rebuilt in place by `session/commands.ts`'s own
   *  `renderCommands`, never by this file. */
  readonly commandsHost: HTMLElement
  readonly composerForm: HTMLFormElement
  readonly composerTextarea: HTMLTextAreaElement
  readonly sendButton: HTMLButtonElement
  readonly noteLine: HTMLElement
  readonly hintLine: HTMLElement
}

export function buildSessionView(container: HTMLElement): SessionRefs {
  container.textContent = ''
  const root = el('div', 'session-view')

  // #103: the rail column — a restore banner host above the rail itself,
  // 16rem wide (session.css collapses it to 12rem below 1000px). Both hosts
  // are rebuilt in place by `session/restore.ts`/`session/rail.ts`, never by
  // this file.
  const railColumn = el('div', 'session-view__rail-column')
  const restoreHost = el('div', 'session-view__restore-host')
  railColumn.appendChild(restoreHost)
  const railHost = el('div', 'session-view__rail-host')
  railColumn.appendChild(railHost)
  root.appendChild(railColumn)

  const pane = el('div', 'session-view__pane')

  const emptyState = el('div', 'session-view__empty')
  emptyState.appendChild(el('p', 'session-view__empty-title', EMPTY_TITLE))
  emptyState.appendChild(el('p', 'session-view__empty-hint', EMPTY_HINT))
  pane.appendChild(emptyState)

  const live = el('div', 'session-view__live')

  const header = el('div', 'session-view__header')
  const pill = el('span', 'session-view__pill')
  pill.setAttribute('role', 'status')
  header.appendChild(pill)
  const headerMeta = el('span', 'session-view__meta')
  header.appendChild(headerMeta)
  const stopButton = button(STOP_BUTTON, 'session-stop', 'session-view__button session-view__button--stop')
  header.appendChild(stopButton)
  const closeButton = button(CLOSE_BUTTON, 'session-close', 'session-view__button session-view__button--close')
  header.appendChild(closeButton)
  live.appendChild(header)

  const bannerHost = el('div', 'session-view__banner-host')
  bannerHost.setAttribute('aria-live', 'polite')
  live.appendChild(bannerHost)

  const list = el('div', 'session-view__list')
  live.appendChild(list)

  const jumpButton = button('', 'session-jump-to-latest', 'session-view__jump')
  jumpButton.hidden = true
  live.appendChild(jumpButton)

  const endedPanel = el('div', 'session-view__ended')
  endedPanel.hidden = true
  live.appendChild(endedPanel)

  const commandsHost = el('div', 'commands-strip')
  live.appendChild(commandsHost)

  const composerForm = document.createElement('form')
  composerForm.className = 'session-view__composer'
  composerForm.dataset.action = 'session-composer'
  const composerTextarea = document.createElement('textarea')
  composerTextarea.className = 'session-view__input'
  composerTextarea.dataset.field = 'session-message'
  composerForm.appendChild(composerTextarea)
  const sendButton = document.createElement('button')
  sendButton.type = 'submit'
  sendButton.className = 'session-view__send'
  composerForm.appendChild(sendButton)
  live.appendChild(composerForm)

  const noteLine = el('p', 'session-view__note')
  noteLine.hidden = true
  live.appendChild(noteLine)

  const hintLine = el('p', 'session-view__hint', COMPOSER_HINT)
  live.appendChild(hintLine)

  pane.appendChild(live)
  root.appendChild(pane)
  container.appendChild(root)

  return {
    root,
    restoreHost,
    railHost,
    pane,
    emptyState,
    live,
    pill,
    headerMeta,
    stopButton,
    closeButton,
    bannerHost,
    list,
    jumpButton,
    endedPanel,
    commandsHost,
    composerForm,
    composerTextarea,
    sendButton,
    noteLine,
    hintLine,
  }
}

/** What the header's meta line shows before `init` has reported a real id —
 *  `null` renders as "new session", matching a fresh (or not-yet-attached)
 *  handle's own `claudeSessionId`. */
function shortId(claudeSessionId: string | null): string {
  return claudeSessionId === null ? 'new session' : `session ${claudeSessionId.slice(0, 8)}`
}

export type SessionScreenState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'starting'; readonly repoLabel: string }
  | { readonly kind: 'start-failed'; readonly title: string; readonly body: string; readonly detail: string | null }
  | {
      readonly kind: 'live'
      readonly snapshot: HostedSessionSnapshot
      readonly repoLabel: string
      readonly sendError: string | null
      readonly closeConfirming: boolean
      readonly interruptNote: string | null
      readonly windowNoteVisible: boolean
      readonly composerValue: string
      /** A start refused because this session is already live (Busy, in the
       *  plan's own UX states) — a transient banner over the live view
       *  itself, never a separate screen. */
      readonly busyBanner: string | null
      /** The `unknown-session` send failure (R1-M2) — disables the composer
       *  regardless of `phase`, since the session is confirmed gone rather
       *  than merely between phases. */
      readonly sessionGone: boolean
    }

function buildEndedPanel(snapshot: HostedSessionSnapshot, repoLabel: string): HTMLElement {
  const end = snapshot.end
  const panel = el('div', 'session-view__ended-content')
  if (end === null) return panel
  panel.appendChild(el('h2', 'session-view__ended-title', END_COPY[end.reason].title))
  panel.appendChild(el('p', 'session-view__ended-body', endBody(end)))
  if (end.message !== null) {
    const pre = document.createElement('pre')
    pre.className = 'session-view__ended-message'
    pre.textContent = end.message
    panel.appendChild(pre)
  }
  if (end.diagnosis !== null) {
    const diagnosisCopy = RUNTIME_COPY[end.diagnosis]
    panel.appendChild(el('h3', 'session-view__ended-diagnosis-title', diagnosisCopy.title))
    panel.appendChild(el('p', 'session-view__ended-diagnosis-body', diagnosisCopy.body))
  }
  const newButton = button(NEW_SESSION_BUTTON, 'session-new-from-ended', 'session-view__new-button')
  newButton.dataset.repoLabel = repoLabel
  panel.appendChild(newButton)
  return panel
}

function pillClass(phase: SessionPhase): string {
  return `session-view__pill session-view__pill--${phase}`
}

function applyStopClose(refs: SessionRefs, phase: SessionPhase): void {
  const copy = PHASE_COPY[phase]
  refs.stopButton.hidden = copy.stop === 'hidden'
  refs.stopButton.disabled = copy.stop === 'disabled' || copy.stop === 'stopping'
  refs.stopButton.textContent = copy.stop === 'stopping' ? 'Stopping…' : STOP_BUTTON

  refs.closeButton.hidden = copy.close === 'hidden'
  refs.closeButton.disabled = copy.close === 'closing'
  refs.closeButton.textContent = copy.close === 'closing' ? 'Closing…' : CLOSE_BUTTON
}

function applyComposer(refs: SessionRefs, phase: SessionPhase, value: string, sessionGone: boolean): void {
  const copy = composerCopy(phase, sessionGone)
  refs.composerTextarea.disabled = copy.disabled
  refs.composerTextarea.placeholder = copy.placeholder
  if (refs.composerTextarea.value !== value) refs.composerTextarea.value = value
  refs.sendButton.hidden = copy.sendLabel === null
  refs.sendButton.textContent = copy.sendLabel ?? ''
  refs.sendButton.disabled = copy.disabled || value.trim() === ''
}

export function renderSessionChrome(refs: SessionRefs, state: SessionScreenState): void {
  refs.root.classList.toggle('session-view--empty', state.kind === 'empty')
  refs.emptyState.hidden = state.kind !== 'empty'
  refs.live.hidden = state.kind === 'empty'

  if (state.kind === 'empty') return

  if (state.kind === 'reconnecting') {
    refs.pill.className = pillClass('starting')
    refs.pill.textContent = '◌ Reconnecting'
    refs.headerMeta.textContent = ''
    refs.bannerHost.textContent = ''
    refs.bannerHost.appendChild(el('p', 'session-view__status', RECONNECTING))
    refs.list.textContent = ''
    refs.endedPanel.hidden = true
    refs.commandsHost.hidden = true
    refs.composerTextarea.disabled = true
    refs.sendButton.hidden = true
    return
  }

  if (state.kind === 'starting') {
    refs.pill.className = pillClass('starting')
    refs.pill.textContent = PHASE_COPY.starting.pill
    refs.headerMeta.textContent = state.repoLabel
    refs.bannerHost.textContent = ''
    refs.bannerHost.appendChild(el('p', 'session-view__status', startingCopy(state.repoLabel)))
    refs.endedPanel.hidden = true
    refs.commandsHost.hidden = true
    applyStopClose(refs, 'starting')
    applyComposer(refs, 'starting', '', false)
    return
  }

  if (state.kind === 'start-failed') {
    refs.bannerHost.textContent = ''
    const banner = el('div', 'session-view__banner session-view__banner--error')
    banner.appendChild(el('p', 'session-view__banner-title', state.title))
    banner.appendChild(el('p', 'session-view__banner-body', state.body))
    if (state.detail !== null) banner.appendChild(el('pre', 'session-view__banner-detail', state.detail))
    refs.bannerHost.appendChild(banner)
    refs.commandsHost.hidden = true
    return
  }

  // state.kind === 'live'
  const { snapshot, repoLabel, sendError, closeConfirming, interruptNote: note, windowNoteVisible, composerValue, busyBanner, sessionGone } = state
  const phase = snapshot.phase

  refs.pill.className = pillClass(phase)
  refs.pill.textContent = phase === 'ended' && snapshot.end !== null ? END_COPY[snapshot.end.reason].title : PHASE_COPY[phase].pill
  refs.headerMeta.textContent = `${repoLabel} · started ${new Date(snapshot.startedAt).toLocaleTimeString()} · ${shortId(snapshot.claudeSessionId)}`

  applyStopClose(refs, phase)
  applyComposer(refs, phase, composerValue, sessionGone)

  refs.bannerHost.textContent = ''
  if (closeConfirming) {
    const confirm = el('div', 'session-view__confirm')
    confirm.appendChild(el('p', 'session-view__confirm-prompt', CLOSE_CONFIRM_PROMPT))
    confirm.appendChild(button(CLOSE_CONFIRM_YES, 'session-close-confirm', 'session-view__button session-view__button--danger'))
    confirm.appendChild(button(CLOSE_CONFIRM_NO, 'session-close-cancel', 'session-view__button'))
    refs.bannerHost.appendChild(confirm)
  } else if (busyBanner !== null) {
    refs.bannerHost.appendChild(el('p', 'session-view__banner session-view__banner--busy', busyBanner))
  } else if (sendError !== null) {
    refs.bannerHost.appendChild(el('p', 'session-view__banner session-view__banner--error', sendError))
  } else if (windowNoteVisible) {
    refs.bannerHost.appendChild(el('p', 'session-view__banner session-view__banner--dim', windowNote()))
  }

  refs.noteLine.hidden = note === null
  refs.noteLine.textContent = note ?? ''

  refs.endedPanel.hidden = phase !== 'ended'
  if (phase === 'ended') {
    refs.endedPanel.textContent = ''
    refs.endedPanel.appendChild(buildEndedPanel(snapshot, repoLabel))
  }
}

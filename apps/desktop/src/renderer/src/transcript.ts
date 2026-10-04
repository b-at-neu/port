// The transcript view (#83, followed live since #84): renders a transcript
// as a scannable message stream that appends and patches in place rather
// than reloading. Row building and the append/patch/pin-to-bottom list model
// moved out to entry-rows.ts/entry-list.ts (#219), shared with the live
// session view — this file keeps only the screen shell: header, subtitle,
// follow toggle, banner host, empty state, and focus behaviour.
import type { EntryPatch, TranscriptEntry, TranscriptFailureKind, TranscriptSource } from '../../shared/sessions/transcript'
import { text } from './entry-rows'
import { createEntryList, NEAR_BOTTOM_PX } from './entry-list'
import type { EntryList } from './entry-list'

export type TranscriptViewState =
  | { readonly status: 'loading' }
  /** An open-time failure — no rows exist yet, so the whole screen is the
   *  error, unlike a poll failure (`showTailBanner`), which keeps every row
   *  already on screen. */
  | { readonly status: 'error'; readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }
  /** The IPC round trip itself failed — distinct from every `TranscriptFailureKind`
   *  above, which are answers the main process itself returned. */
  | { readonly status: 'unreachable' }
  /** `focusIndex` is the entry ordinal to scroll to, highlight, and expand
   *  on open -- set when a search hit opened this transcript, `null` from
   *  the sessions picker. Read once, on the first `renderTranscript` call;
   *  a later poll never re-focuses anything. */
  | { readonly status: 'ready'; readonly source: TranscriptSource; readonly entries: readonly TranscriptEntry[]; readonly title: string; readonly focusIndex: number | null }

function failureCopy(state: Extract<TranscriptViewState, { status: 'error' }>): string {
  const path = state.path ?? ''
  switch (state.kind) {
    case 'not-found':
      return `No transcript file at ${path}. The session may have been deleted.`
    case 'session-unresolved':
      return "Couldn't locate this session's directory under your Claude projects folder."
    case 'too-large':
      return `This transcript is past the 64 MB Port will read. Open it directly: ${path}`
    case 'unreadable':
      return `Couldn't read ${path} — ${state.message}`
    case 'invalid-id':
      return "That session or agent id isn't a valid identifier."
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function subtitleFor(source: TranscriptSource, entryCount: number): string {
  return [
    source.agentId !== null ? `agent-${source.agentId}` : source.sessionId,
    `${entryCount} messages`,
    formatBytes(source.sizeBytes),
    `last change ${new Date(source.modifiedAt).toLocaleTimeString()}`,
  ].join(' · ')
}

function setFollowToggleState(button: HTMLButtonElement, following: boolean): void {
  button.textContent = following ? 'Following' : 'Paused'
  button.setAttribute('aria-pressed', String(following))
}

function buildHeader(title: string, following: boolean): { readonly header: HTMLElement; readonly subtitle: HTMLElement; readonly followToggle: HTMLButtonElement } {
  const header = document.createElement('div')
  header.className = 'transcript-header'

  const top = document.createElement('div')
  top.className = 'transcript-header__top'
  const back = document.createElement('button')
  back.className = 'transcript-header__back'
  back.textContent = '‹ Back'
  back.dataset.action = 'back-to-sessions'
  top.appendChild(back)
  top.appendChild(text('span', 'transcript-header__title', title))

  const followToggle = document.createElement('button')
  followToggle.className = 'transcript-header__follow'
  followToggle.dataset.action = 'toggle-follow'
  setFollowToggleState(followToggle, following)
  top.appendChild(followToggle)
  header.appendChild(top)

  const subtitle = text('div', 'transcript-header__subtitle', '')
  header.appendChild(subtitle)
  return { header, subtitle, followToggle }
}

/** The live view's own model — `entryList` owns row building, appending,
 *  patching, and the jump affordance; this level adds only what the
 *  transcript screen itself needs on top (the subtitle, the follow toggle,
 *  the banner host, the empty state). */
interface LiveModel {
  readonly entryList: EntryList
  readonly subtitleEl: HTMLElement
  readonly followToggle: HTMLButtonElement
  readonly bannerHost: HTMLElement
  entryCount: number
  emptyEl: HTMLElement | null
}

let live: LiveModel | null = null

export function renderTranscript(container: HTMLElement, state: TranscriptViewState): void {
  live?.entryList.dispose()
  live = null
  container.textContent = ''

  if (state.status === 'loading') {
    container.appendChild(buildHeader('Transcript', true).header)
    container.appendChild(text('p', 'transcript-status', 'Loading…'))
    return
  }

  if (state.status === 'error') {
    container.appendChild(buildHeader('Transcript', false).header)
    container.appendChild(text('p', 'transcript-status transcript-status--error', failureCopy(state)))
    return
  }

  if (state.status === 'unreachable') {
    container.appendChild(buildHeader('Transcript', false).header)
    container.appendChild(text('p', 'transcript-status transcript-status--error', 'Could not reach the main process.'))
    return
  }

  const { source, entries, title, focusIndex } = state
  const { header, subtitle, followToggle } = buildHeader(title, true)
  container.appendChild(header)
  subtitle.textContent = subtitleFor(source, entries.length)

  const bannerHost = document.createElement('div')
  bannerHost.className = 'transcript-banner-host'
  container.appendChild(bannerHost)

  if (source.malformedLines > 0) {
    container.appendChild(text('p', 'transcript-note', `${source.malformedLines} lines in this transcript couldn't be parsed and aren't shown.`))
  }

  let emptyEl: HTMLElement | null = null
  if (entries.length === 0) {
    emptyEl = text('p', 'transcript-empty', 'This transcript has no messages yet.')
    container.appendChild(emptyEl)
  }

  const list = document.createElement('div')
  list.className = 'transcript-list'
  container.appendChild(list)

  const jumpButton = document.createElement('button')
  jumpButton.className = 'transcript-jump'
  jumpButton.dataset.action = 'jump-to-latest'
  jumpButton.hidden = true
  container.appendChild(jumpButton)

  const entryList = createEntryList({ list, jumpButton, baseIndex: 0, focusIndex })

  list.addEventListener('scroll', () => {
    if (live !== null && list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM_PX) {
      entryList.clearPendingBelow()
    }
  })

  live = { entryList, subtitleEl: subtitle, followToggle, bannerHost, entryCount: 0, emptyEl }
  entryList.append(entries)
  live.entryCount = entries.length
}

export interface TailDelta {
  readonly appended: readonly TranscriptEntry[]
  readonly patched: readonly EntryPatch[]
  readonly source: TranscriptSource
}

/** Applies one poll's delta onto the view already on screen -- never a
 *  re-render, which would drop every `<details>` the operator had open. */
export function applyTailDelta(delta: TailDelta): void {
  if (live === null) return
  live.entryList.patch(delta.patched)

  if (delta.appended.length > 0) {
    live.entryList.append(delta.appended)
    live.entryCount += delta.appended.length
    if (live.emptyEl !== null) {
      live.emptyEl.remove()
      live.emptyEl = null
    }
  }

  live.subtitleEl.textContent = subtitleFor(delta.source, live.entryCount)
}

/** `data-action="jump-to-latest"`'s handler. */
export function jumpToLatest(): void {
  live?.entryList.jumpToLatest()
}

/** Flips the header's follow toggle without touching anything else --
 *  called on every `toggle-follow` click and whenever a poll failure pauses
 *  following automatically. */
export function setFollowingIndicator(following: boolean): void {
  if (live === null) return
  setFollowToggleState(live.followToggle, following)
}

/** `transcript-banner.ts`'s one seam into this module's private `live`
 *  model -- split out once the banner functions plus the search screen's
 *  own wiring pushed this file past ENGINEERING §7's 500-line limit. */
export function getBannerHost(): HTMLElement | null {
  return live?.bannerHost ?? null
}

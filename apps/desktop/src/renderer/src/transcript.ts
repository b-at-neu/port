// The transcript view (#83, followed live since #84): renders a transcript
// as a scannable message stream that appends and patches in place rather
// than reloading. Every node is built with `document.createElement`/
// `textContent`, never `innerHTML` — a tool result is untrusted text from
// the network and from repositories (`scripts/checks/desktop-renderer.mjs`
// pins the absence of an HTML-injection sink across this directory).
// #80 replaces this screen wholesale; until then it stays plain DOM.
import type { EntryPatch, DiffHunk, FileDiff, Payload, ToolCallEntry, TranscriptEntry, TranscriptFailureKind, TranscriptSource } from '../../shared/sessions/transcript'

export type TranscriptViewState =
  | { readonly status: 'loading' }
  /** An open-time failure — no rows exist yet, so the whole screen is the
   *  error, unlike a poll failure (`showTailBanner`), which keeps every row
   *  already on screen. */
  | { readonly status: 'error'; readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }
  /** The IPC round trip itself failed — distinct from every `TranscriptFailureKind`
   *  above, which are answers the main process itself returned. */
  | { readonly status: 'unreachable' }
  | { readonly status: 'ready'; readonly source: TranscriptSource; readonly entries: readonly TranscriptEntry[]; readonly title: string }

/** Above this many entries, the list is appended in slices across
 *  `requestAnimationFrame` calls rather than in one synchronous pass — the
 *  largest observed transcript renders roughly 3,500 rows. Applies equally
 *  to the initial full render and to a large incremental catch-up. */
const CHUNK_THRESHOLD = 500
const CHUNK_SIZE = 200
const PROMPT_CLAMP_LINES = 12

/** Within this many pixels of the bottom counts as "already there" for the
 *  pin-to-bottom behaviour. */
const NEAR_BOTTOM_PX = 64

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

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

function buildPayload(payload: Payload): HTMLElement {
  const wrap = document.createElement('div')
  const pre = document.createElement('pre')
  pre.className = 'entry__payload'
  pre.textContent = payload.text
  wrap.appendChild(pre)
  if (payload.omittedChars > 0) {
    wrap.appendChild(text('p', 'entry__truncated', `${payload.omittedChars} characters not shown`))
  }
  return wrap
}

function buildClampedText(payload: Payload, label: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'entry__prompt'
  wrap.appendChild(text('span', 'entry__prompt-label', label))

  const lines = payload.text.split('\n')
  const pre = document.createElement('pre')
  pre.className = 'entry__payload'
  pre.textContent = lines.length > PROMPT_CLAMP_LINES ? lines.slice(0, PROMPT_CLAMP_LINES).join('\n') : payload.text
  wrap.appendChild(pre)

  if (lines.length > PROMPT_CLAMP_LINES) {
    const toggle = document.createElement('button')
    toggle.className = 'entry__show-all'
    toggle.textContent = 'Show all'
    toggle.addEventListener('click', () => {
      pre.textContent = payload.text
      toggle.remove()
    })
    wrap.appendChild(toggle)
  }
  if (payload.omittedChars > 0) {
    wrap.appendChild(text('p', 'entry__truncated', `${payload.omittedChars} characters not shown`))
  }
  return wrap
}

function buildHunk(hunk: DiffHunk): HTMLElement {
  const block = document.createElement('div')
  block.className = 'diff-hunk'
  block.appendChild(text('div', 'diff-hunk__header', `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`))
  const lines = document.createElement('pre')
  lines.className = 'diff-hunk__lines'
  for (const line of hunk.lines) {
    lines.appendChild(text('div', `diff-line diff-line--${line.sign}`, line.text))
  }
  block.appendChild(lines)
  return block
}

function buildDiff(diff: FileDiff): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'diff'
  wrap.appendChild(text('div', 'diff__summary', `${diff.isNewFile ? '(new file) ' : ''}${diff.path}  +${diff.additions} -${diff.deletions}`))
  for (const hunk of diff.hunks) wrap.appendChild(buildHunk(hunk))
  return wrap
}

function resultChip(entry: ToolCallEntry): HTMLElement {
  const label = entry.result === null ? 'no result' : entry.result.isError ? 'error' : 'ok'
  return text('span', `entry__chip entry__chip--${entry.result === null ? 'none' : entry.result.isError ? 'error' : 'ok'}`, label)
}

function buildToolCall(entry: ToolCallEntry): HTMLElement {
  const details = document.createElement('details')
  details.className = 'entry entry--tool-call'

  const summary = document.createElement('summary')
  summary.className = 'entry__summary'
  summary.appendChild(text('span', 'entry__tool-name', entry.name))
  summary.appendChild(text('span', 'entry__headline', entry.headline))
  summary.appendChild(resultChip(entry))
  details.appendChild(summary)

  const body = document.createElement('div')
  body.className = 'entry__body'
  body.appendChild(text('div', 'entry__label', 'Input'))
  body.appendChild(buildPayload(entry.input))

  if (entry.diff !== null) {
    body.appendChild(buildDiff(entry.diff))
  } else if (entry.result !== null) {
    body.appendChild(text('div', 'entry__label', 'Result'))
    body.appendChild(buildPayload(entry.result.payload))
  }
  details.appendChild(body)
  return details
}

function buildThinking(entry: Extract<TranscriptEntry, { type: 'thinking' }>): HTMLElement {
  const details = document.createElement('details')
  details.className = 'entry entry--thinking'
  const wordCount = entry.text.text.split(/\s+/).filter((word) => word !== '').length
  const summary = document.createElement('summary')
  summary.className = 'entry__summary'
  summary.textContent = `Thinking · ${wordCount} words`
  details.appendChild(summary)
  const body = document.createElement('div')
  body.className = 'entry__body entry__body--dim'
  body.appendChild(buildPayload(entry.text))
  details.appendChild(body)
  return details
}

function buildRow(entry: TranscriptEntry): HTMLElement {
  switch (entry.type) {
    case 'user-text':
      return buildClampedText(entry.text, 'Prompt')
    case 'assistant-text': {
      const wrap = document.createElement('div')
      wrap.className = 'entry entry--assistant'
      wrap.appendChild(text('span', 'entry__label', 'Claude'))
      wrap.appendChild(buildPayload(entry.text))
      return wrap
    }
    case 'thinking':
      return buildThinking(entry)
    case 'tool-call':
      return buildToolCall(entry)
    case 'meta':
      return text('div', 'entry entry--meta', `System · ${entry.label}`)
  }
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
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

/** Bumped on every full `renderTranscript` call — a chunk loop from a stale
 *  render checks its own captured value against this counter and discards
 *  itself the moment a navigation started a newer one, rather than
 *  appending rows into a list the operator already left. */
let renderGeneration = 0

/** The live view's own model, reset on every full `renderTranscript` call —
 *  `entries`/`rows` are mutated in place by `applyTailDelta` so a follow
 *  session never rebuilds the list it is already showing. `rows[i]` stays
 *  `undefined` until the (possibly still-chunking) append loop actually
 *  builds that row; a patch arriving before that just updates `entries[i]`,
 *  which the loop reads fresh when it gets there — it can never build a
 *  stale row. */
interface LiveModel {
  readonly list: HTMLElement
  readonly rows: (HTMLElement | undefined)[]
  readonly entries: TranscriptEntry[]
  readonly subtitleEl: HTMLElement
  readonly followToggle: HTMLButtonElement
  readonly jumpButton: HTMLButtonElement
  readonly bannerHost: HTMLElement
  emptyEl: HTMLElement | null
  pendingBelow: number
}

let live: LiveModel | null = null

function buildAndAppendRow(index: number): void {
  if (live === null) return
  const entry = live.entries[index]
  if (entry === undefined) return
  const row = buildRow(entry)
  live.rows[index] = row
  live.list.appendChild(row)
}

function appendRange(start: number, end: number, generation: number): void {
  const total = end - start
  if (total <= CHUNK_THRESHOLD) {
    for (let i = start; i < end; i++) buildAndAppendRow(i)
    return
  }

  let index = start
  function appendNext(): void {
    if (generation !== renderGeneration || live === null) return
    const sliceEnd = Math.min(end, index + CHUNK_SIZE)
    for (let i = index; i < sliceEnd; i++) buildAndAppendRow(i)
    index = sliceEnd
    if (index < end) requestAnimationFrame(appendNext)
  }
  appendNext()
}

function updateJumpButton(): void {
  if (live === null) return
  if (live.pendingBelow > 0) {
    live.jumpButton.textContent = `${live.pendingBelow} new below ↓`
    live.jumpButton.hidden = false
  } else {
    live.jumpButton.hidden = true
  }
}

function applyPatch(patch: EntryPatch): void {
  if (live === null) return
  live.entries[patch.index] = patch.entry
  const existingRow = live.rows[patch.index]
  if (existingRow === undefined) return // not rendered yet -- appendRange picks up the patched entry when it gets there
  const newRow = buildRow(patch.entry)
  // Carries the row's open state across the swap -- an operator with a tool
  // call expanded must not have it silently collapse the moment its result
  // arrives.
  if (existingRow instanceof HTMLDetailsElement && newRow instanceof HTMLDetailsElement) {
    newRow.open = existingRow.open
  }
  existingRow.replaceWith(newRow)
  live.rows[patch.index] = newRow
}

export function renderTranscript(container: HTMLElement, state: TranscriptViewState): void {
  renderGeneration += 1
  const generation = renderGeneration
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

  const { source, entries, title } = state
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

  list.addEventListener('scroll', () => {
    if (live !== null && isNearBottom(list)) {
      live.pendingBelow = 0
      updateJumpButton()
    }
  })

  live = {
    list,
    rows: [],
    entries: entries.slice(),
    subtitleEl: subtitle,
    followToggle,
    jumpButton,
    bannerHost,
    emptyEl,
    pendingBelow: 0,
  }

  appendRange(0, entries.length, generation)
}

export interface TailDelta {
  readonly appended: readonly TranscriptEntry[]
  readonly patched: readonly EntryPatch[]
  readonly source: TranscriptSource
}

/** Applies one poll's delta onto the view already on screen -- never a
 *  re-render, which would drop every `<details>` the operator had open.
 *  Pinned to the bottom when the operator already was there (within
 *  `NEAR_BOTTOM_PX`); otherwise nothing scrolls and the jump affordance's
 *  counter grows instead. */
export function applyTailDelta(delta: TailDelta): void {
  if (live === null) return
  const generation = renderGeneration
  const wasAtBottom = isNearBottom(live.list)

  for (const patch of delta.patched) applyPatch(patch)

  if (delta.appended.length > 0) {
    const start = live.entries.length
    live.entries.push(...delta.appended)
    appendRange(start, live.entries.length, generation)
    if (live.emptyEl !== null) {
      live.emptyEl.remove()
      live.emptyEl = null
    }
  }

  live.subtitleEl.textContent = subtitleFor(delta.source, live.entries.length)

  if (delta.appended.length === 0) return

  if (wasAtBottom) {
    live.pendingBelow = 0
    updateJumpButton()
    const listEl = live.list
    requestAnimationFrame(() => {
      listEl.scrollTop = listEl.scrollHeight
    })
  } else {
    live.pendingBelow += delta.appended.length
    updateJumpButton()
  }
}

/** `data-action="jump-to-latest"`'s handler -- scrolls to the bottom and
 *  clears the counter, the same effect reaching the bottom by hand has. */
export function jumpToLatest(): void {
  if (live === null) return
  live.list.scrollTop = live.list.scrollHeight
  live.pendingBelow = 0
  updateJumpButton()
}

/** Flips the header's follow toggle without touching anything else --
 *  called on every `toggle-follow` click and whenever a poll failure pauses
 *  following automatically. */
export function setFollowingIndicator(following: boolean): void {
  if (live === null) return
  setFollowToggleState(live.followToggle, following)
}

export type TailBannerKind = 'not-found' | 'unreadable' | 'too-large' | 'unreachable'

function bannerCopy(kind: TailBannerKind, message: string, path: string | null): string {
  const p = path ?? ''
  switch (kind) {
    case 'not-found':
      return `The transcript file is gone — it may have been deleted. ${p}`
    case 'unreadable':
      return `Couldn't read ${p} — ${message}`
    case 'too-large':
      return `This transcript has grown past the 64 MB Port will read. Open it directly: ${p}`
    case 'unreachable':
      return 'Lost contact with the main process.'
  }
}

/** Shows an error banner above the rows already on screen -- nothing is
 *  ever wiped, since losing the transcript the operator is mid-read is
 *  worse than the error. `too-large` carries no `Retry`, since retrying
 *  cannot help. */
export function showTailBanner(kind: TailBannerKind, message: string, path: string | null): void {
  if (live === null) return
  live.bannerHost.textContent = ''
  const banner = document.createElement('div')
  banner.className = 'transcript-banner'
  banner.appendChild(text('p', 'transcript-banner__message', bannerCopy(kind, message, path)))
  if (kind !== 'too-large') {
    const retry = document.createElement('button')
    retry.className = 'transcript-banner__retry'
    retry.textContent = 'Retry'
    retry.dataset.action = 'retry-transcript'
    banner.appendChild(retry)
  }
  live.bannerHost.appendChild(banner)
}

export function clearTailBanner(): void {
  if (live === null) return
  live.bannerHost.textContent = ''
}

/** `truncated` carries no banner -- the caller re-opens (a fresh
 *  `renderTranscript` call) and then calls this once, so the dim note
 *  survives that reset. */
export function showTruncatedNote(): void {
  if (live === null) return
  live.bannerHost.textContent = ''
  live.bannerHost.appendChild(text('p', 'transcript-note transcript-note--dim', 'This transcript was rewritten — reloaded from the start.'))
}

// The transcript view (#83): renders a `TranscriptRead` as a scannable
// message stream. Every node is built with `document.createElement`/
// `textContent`, never `innerHTML` — a tool result is untrusted text from
// the network and from repositories (`scripts/checks/desktop-renderer.mjs`
// pins the absence of an HTML-injection sink across this directory).
// #80 replaces this screen wholesale; until then it stays plain DOM.
import type { DiffHunk, FileDiff, Payload, ToolCallEntry, TranscriptEntry, TranscriptFailureKind, TranscriptRead } from '../../shared/sessions/transcript'

export type TranscriptViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }
  /** The IPC round trip itself failed — distinct from every `TranscriptFailureKind`
   *  above, which are answers `readTranscript` itself returned. */
  | { readonly status: 'unreachable' }
  | { readonly status: 'ready'; readonly read: Extract<TranscriptRead, { ok: true }>; readonly title: string }

/** Above this many entries, the list is appended in slices across
 *  `requestAnimationFrame` calls rather than in one synchronous pass — the
 *  largest observed transcript renders roughly 3,500 rows. */
const CHUNK_THRESHOLD = 500
const CHUNK_SIZE = 200
const PROMPT_CLAMP_LINES = 12

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

/** Bumped on every `renderTranscript` call — a chunk loop from a stale
 *  render checks its own captured value against this counter and discards
 *  itself the moment a navigation started a newer one, rather than
 *  appending rows into a list the operator already left. */
let renderGeneration = 0

function appendChunked(container: HTMLElement, entries: readonly TranscriptEntry[], generation: number): void {
  if (entries.length <= CHUNK_THRESHOLD) {
    for (const entry of entries) container.appendChild(buildRow(entry))
    return
  }

  let index = 0
  function appendNext(): void {
    if (generation !== renderGeneration) return
    const slice = entries.slice(index, index + CHUNK_SIZE)
    for (const entry of slice) container.appendChild(buildRow(entry))
    index += CHUNK_SIZE
    if (index < entries.length) requestAnimationFrame(appendNext)
  }
  appendNext()
}

function buildHeader(title: string, subtitle: string): HTMLElement {
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
  const reload = document.createElement('button')
  reload.className = 'transcript-header__reload'
  reload.textContent = 'Reload'
  reload.dataset.action = 'reload-transcript'
  top.appendChild(reload)
  header.appendChild(top)

  header.appendChild(text('div', 'transcript-header__subtitle', subtitle))
  return header
}

export function renderTranscript(container: HTMLElement, state: TranscriptViewState): void {
  renderGeneration += 1
  const generation = renderGeneration
  container.textContent = ''

  if (state.status === 'loading') {
    container.appendChild(buildHeader('Transcript', ''))
    container.appendChild(text('p', 'transcript-status', 'Loading…'))
    return
  }

  if (state.status === 'error') {
    container.appendChild(buildHeader('Transcript', ''))
    container.appendChild(text('p', 'transcript-status transcript-status--error', failureCopy(state)))
    return
  }

  if (state.status === 'unreachable') {
    container.appendChild(buildHeader('Transcript', ''))
    container.appendChild(text('p', 'transcript-status transcript-status--error', 'Could not reach the main process.'))
    return
  }

  const { source, entries } = state.read
  const subtitle = [
    source.agentId !== null ? `agent-${source.agentId}` : source.sessionId,
    `${entries.length} messages`,
    formatBytes(source.sizeBytes),
    `last change ${new Date(source.modifiedAt).toLocaleTimeString()}`,
  ].join(' · ')
  container.appendChild(buildHeader(state.title, subtitle))

  if (source.malformedLines > 0) {
    container.appendChild(text('p', 'transcript-note', `${source.malformedLines} lines in this transcript couldn't be parsed and aren't shown.`))
  }

  if (entries.length === 0) {
    container.appendChild(text('p', 'transcript-empty', 'This transcript has no messages yet.'))
    return
  }

  const list = document.createElement('div')
  list.className = 'transcript-list'
  container.appendChild(list)
  appendChunked(list, entries, generation)
}

// The row builders for one `TranscriptEntry` (#83, moved verbatim out of
// transcript.ts by #219 so the live session view and the on-disk transcript
// view share one renderer — the "three renderers" trap #123 flagged). Every
// node is built with `document.createElement`/`textContent`, never
// `innerHTML` — a tool result is untrusted text from the network and from
// repositories (`scripts/checks/desktop-renderer.ts` pins the absence of an
// HTML-injection sink across this directory).
import type { DiffHunk, FileDiff, Payload, ToolCallEntry, TranscriptEntry } from '../../shared/sessions/transcript'

const PROMPT_CLAMP_LINES = 12

export function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

export function buildPayload(payload: Payload): HTMLElement {
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

export function buildClampedText(payload: Payload, label: string): HTMLElement {
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

export function buildHunk(hunk: DiffHunk): HTMLElement {
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

export function buildDiff(diff: FileDiff): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'diff'
  wrap.appendChild(text('div', 'diff__summary', `${diff.isNewFile ? '(new file) ' : ''}${diff.path}  +${diff.additions} -${diff.deletions}`))
  for (const hunk of diff.hunks) wrap.appendChild(buildHunk(hunk))
  return wrap
}

export function resultChip(entry: ToolCallEntry): HTMLElement {
  const label = entry.result === null ? 'no result' : entry.result.isError ? 'error' : 'ok'
  return text('span', `entry__chip entry__chip--${entry.result === null ? 'none' : entry.result.isError ? 'error' : 'ok'}`, label)
}

export function buildToolCall(entry: ToolCallEntry): HTMLElement {
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

export function buildThinking(entry: Extract<TranscriptEntry, { type: 'thinking' }>): HTMLElement {
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

export function buildRow(entry: TranscriptEntry): HTMLElement {
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

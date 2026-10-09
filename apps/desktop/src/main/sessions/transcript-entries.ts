// A `tool_use` block and the `tool_result` that later carries its id collapse into one entry; an unpaired call keeps `result: null` rather than being dropped.
import type { DiffHunk, DiffLine, DiffSign, EntryPatch, FileDiff, MetaEntry, Payload, ToolCallEntry, TranscriptEntry } from '../../shared/sessions/transcript'
import { MAX_PAYLOAD_CHARS } from '../../shared/sessions/transcript'
import { isRecord } from '../../shared/guards'

export interface DeriveEntriesOptions {
  /** Used only to shorten a headline path, never to resolve or open anything. */
  readonly cwd: string | null
}

const DEFAULT_OPTIONS: DeriveEntriesOptions = { cwd: null }

type CodePointRange = readonly [number, number]

/** A tool result is attacker-influenced text: an ANSI escape run renders as garbage, a bidi override silently reverses how a path reads. */
const CONTROL_RANGES: readonly CodePointRange[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
]

/** LRE, RLE, PDF, LRO, RLO (U+202A-U+202E) and LRI, RLI, FSI, PDI
 *  (U+2066-U+2069). */
const BIDI_RANGES: readonly CodePointRange[] = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

function isInRanges(codePoint: number, ranges: readonly CodePointRange[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
}

export function sanitize(text: string): string {
  let out = ''
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (isInRanges(codePoint, CONTROL_RANGES) || isInRanges(codePoint, BIDI_RANGES)) continue
    out += char
  }
  return out
}

/** So a slice holding a few stripped control/bidi characters still fills `cap` in one pass. */
const CAP_SLACK = 256

export function capPayload(text: string, cap: number = MAX_PAYLOAD_CHARS): Payload {
  // Sanitizing advances in bounded slices so a large tool result never pays the full pass for content discarded past `cap`.
  let read = 0
  let sanitized = ''
  while (sanitized.length <= cap && read < text.length) {
    const next = Math.min(text.length, read + (cap - sanitized.length) + CAP_SLACK)
    sanitized += sanitize(text.slice(read, next))
    read = next
  }

  // The never-read remainder is counted raw, so `omittedChars` is an approximate count, deliberately, not an exact one.
  const rawRemainder = text.length - read
  if (sanitized.length > cap) return { text: sanitized.slice(0, cap), omittedChars: rawRemainder + (sanitized.length - cap) }
  return { text: sanitized, omittedChars: rawRemainder }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const HEADLINE_MAX = 200

function relativeToCwd(filePath: string, cwd: string | null): string {
  if (cwd === null || cwd === '') return filePath
  if (filePath === cwd) return '.'
  for (const sep of ['/', '\\']) {
    const prefix = `${cwd}${sep}`
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length)
  }
  return filePath
}

/** Per-tool field extraction, falling back to the first string-valued input field or the tool name. Capped at 200 characters. */
export function headlineFor(name: string, input: unknown, cwd: string | null): string {
  const fields = isRecord(input) ? input : {}
  let headline: string

  switch (name) {
    case 'Bash': {
      const command = fields['command']
      headline = typeof command === 'string' ? (command.split('\n')[0] ?? command) : name
      break
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const filePath = fields['file_path']
      headline = typeof filePath === 'string' ? relativeToCwd(filePath, cwd) : name
      break
    }
    case 'Grep': {
      const pattern = stringOr(fields['pattern'], '')
      const path = stringOr(fields['path'], '')
      headline = path !== '' ? `${pattern} ${path}` : pattern
      break
    }
    case 'Glob':
      headline = stringOr(fields['pattern'], name)
      break
    case 'Task':
      headline = stringOr(fields['description'], name)
      break
    case 'TodoWrite': {
      const todos = fields['todos']
      headline = `${Array.isArray(todos) ? todos.length : 0} todo${Array.isArray(todos) && todos.length === 1 ? '' : 's'}`
      break
    }
    case 'WebFetch':
      headline = stringOr(fields['url'], name)
      break
    default: {
      const firstString = Object.values(fields).find((value): value is string => typeof value === 'string')
      headline = firstString ?? name
    }
  }

  // The headline is always visible without expanding a `<details>`, so it is sanitized here too; `sanitize` only shrinks, so the length cap still applies after.
  const sanitized = sanitize(headline)
  return sanitized.length > HEADLINE_MAX ? sanitized.slice(0, HEADLINE_MAX) : sanitized
}

function imagePlaceholder(block: Record<string, unknown>): string {
  const source = block['source']
  let kb = 0
  if (isRecord(source) && typeof source['data'] === 'string') {
    kb = Math.round((source['data'].length * 0.75) / 1024)
  }
  return `[image, ${kb} KB -- not shown]`
}

/** Array-form content is joined into one payload, with an image replaced by a placeholder rather than a `data:` URL the CSP would otherwise permit. */
function resultTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'])
    } else if (block['type'] === 'image') {
      parts.push(imagePlaceholder(block))
    }
  }
  return parts.join('\n')
}

function signOf(line: string): DiffSign {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

function hunkFromRaw(raw: unknown): DiffHunk | null {
  if (!isRecord(raw)) return null
  const { oldStart, oldLines, newStart, newLines, lines } = raw
  if (typeof oldStart !== 'number' || typeof oldLines !== 'number' || typeof newStart !== 'number' || typeof newLines !== 'number' || !Array.isArray(lines)) {
    return null
  }
  const diffLines: DiffLine[] = lines.filter((line): line is string => typeof line === 'string').map((line) => ({ sign: signOf(line), text: line }))
  return { oldStart, oldLines, newStart, newLines, lines: diffLines }
}

function countSign(hunks: readonly DiffHunk[], sign: DiffSign): number {
  return hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.sign === sign).length, 0)
}

/** A `Write` create carries an empty `structuredPatch`, so that case synthesizes one all-additions hunk from the paired `tool_use`'s `input.content` instead. */
function diffFromToolUseResult(toolUseResult: unknown, rawInput: unknown): FileDiff | null {
  if (!isRecord(toolUseResult)) return null
  const filePath = toolUseResult['filePath']
  if (typeof filePath !== 'string') return null

  const isCreate = toolUseResult['type'] === 'create'
  const rawPatch = toolUseResult['structuredPatch']
  const patchHunks = Array.isArray(rawPatch) ? rawPatch : []

  if (patchHunks.length > 0) {
    const hunks = patchHunks.map(hunkFromRaw).filter((hunk): hunk is DiffHunk => hunk !== null)
    if (hunks.length === 0) return null
    return { path: filePath, isNewFile: isCreate, additions: countSign(hunks, 'add'), deletions: countSign(hunks, 'del'), hunks }
  }

  if (isCreate) {
    const content = isRecord(rawInput) && typeof rawInput['content'] === 'string' ? rawInput['content'] : null
    if (content === null) return null
    const lines = content.split('\n')
    const hunk: DiffHunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line) => ({ sign: 'add' as const, text: `+${line}` })),
    }
    return { path: filePath, isNewFile: true, additions: lines.length, deletions: 0, hunks: [hunk] }
  }

  return null
}

function attachmentLabel(attachment: unknown): string {
  if (!isRecord(attachment)) return 'attachment'
  const kind = attachment['type']
  if (kind === 'skill_listing') {
    const count = attachment['skillCount']
    return `skill listing (${typeof count === 'number' ? count : 0} skills)`
  }
  if (kind === 'deferred_tools_delta') {
    const added = attachment['addedNames']
    return `deferred tools (+${Array.isArray(added) ? added.length : 0})`
  }
  if (typeof kind === 'string' && kind !== '') return kind.replace(/_/g, ' ')
  return 'attachment'
}

export interface DerivedChunk {
  readonly appended: readonly TranscriptEntry[]
  readonly patched: readonly EntryPatch[]
}

export interface Deriver {
  /** Returns only this batch's delta, never the whole transcript, so a caller can apply it directly onto a list it already holds. */
  push(records: readonly unknown[]): DerivedChunk
}

/** Pairs a `tool_use` with its `tool_result` by id, never position, even across separate `push` calls. A record this module cannot recognize is skipped rather than thrown on. A tool call pairs once: its pending entry and raw input are pruned the moment a result claims it, so a duplicate result cannot overwrite a real diff and inputs never accumulate unboundedly. */
export function createDeriver(options: DeriveEntriesOptions = DEFAULT_OPTIONS): Deriver {
  let nextIndex = 0
  const pendingById = new Map<string, { readonly index: number; readonly entry: ToolCallEntry }>()
  const rawInputById = new Map<string, unknown>()

  function push(records: readonly unknown[]): DerivedChunk {
    const appended: TranscriptEntry[] = []
    const patched: EntryPatch[] = []

    function emit(entry: TranscriptEntry): void {
      appended.push(entry)
      nextIndex += 1
    }

    for (const raw of records) {
      if (!isRecord(raw)) continue
      const uuid = raw['uuid']
      const timestamp = raw['timestamp']
      if (typeof uuid !== 'string' || typeof timestamp !== 'string') continue

      if (raw['type'] === 'attachment') {
        const entry: MetaEntry = { type: 'meta', uuid, timestamp, label: attachmentLabel(raw['attachment']) }
        emit(entry)
        continue
      }

      const message = raw['message']
      if (!isRecord(message)) continue
      const role = message['role']
      const content = message['content']

      if (typeof content === 'string') {
        if (role === 'user') emit({ type: 'user-text', uuid, timestamp, text: capPayload(content) })
        else if (role === 'assistant') emit({ type: 'assistant-text', uuid, timestamp, text: capPayload(content) })
        continue
      }

      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (!isRecord(block)) continue
        const blockType = block['type']

        if (blockType === 'text' && typeof block['text'] === 'string') {
          emit({ type: role === 'user' ? 'user-text' : 'assistant-text', uuid, timestamp, text: capPayload(block['text']) })
          continue
        }

        if (blockType === 'thinking' && typeof block['thinking'] === 'string') {
          emit({ type: 'thinking', uuid, timestamp, text: capPayload(block['thinking']) })
          continue
        }

        if (blockType === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
          const id = block['id']
          const name = block['name']
          const input = block['input']
          const entry: ToolCallEntry = {
            type: 'tool-call',
            uuid,
            timestamp,
            name,
            headline: headlineFor(name, input, options.cwd),
            input: capPayload(safeStringify(input)),
            result: null,
            diff: null,
          }
          pendingById.set(id, { index: nextIndex, entry })
          rawInputById.set(id, input)
          emit(entry)
          continue
        }

        if (blockType === 'tool_result' && typeof block['tool_use_id'] === 'string') {
          const id = block['tool_use_id']
          const pending = pendingById.get(id)
          if (pending === undefined) continue
          // First result wins — removed before the patch is built, so a duplicate is a no-op.
          pendingById.delete(id)
          const rawInput = rawInputById.get(id)
          rawInputById.delete(id)

          const isError = block['is_error'] === true
          const payload = capPayload(resultTextOf(block['content']))
          const diff = diffFromToolUseResult(raw['toolUseResult'], rawInput)
          patched.push({ index: pending.index, entry: { ...pending.entry, result: { isError, payload }, diff } })
        }
      }
    }

    return { appended, patched }
  }

  return { push }
}


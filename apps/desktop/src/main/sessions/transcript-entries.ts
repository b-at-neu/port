// Pure normalizer (#83): already-parsed `.jsonl` records -> renderer-safe
// `TranscriptEntry[]`. No filesystem or SDK access here -- `transcript.ts`
// owns the read, this module only derives. A `tool_use` block and the
// `tool_result` block that later carries its id collapse into one entry;
// an unpaired call (the result never arrived within the read window) keeps
// `result: null` rather than being dropped.
import type { DiffHunk, DiffLine, DiffSign, FileDiff, MetaEntry, Payload, ToolCallEntry, TranscriptEntry } from '../../shared/sessions/transcript'
import { MAX_PAYLOAD_CHARS } from '../../shared/sessions/transcript'

export interface DeriveEntriesOptions {
  /** The session's own `cwd`, used only to shorten a headline path -- never
   *  to resolve or open anything. `null` when the record carried none. */
  readonly cwd: string | null
}

const DEFAULT_OPTIONS: DeriveEntriesOptions = { cwd: null }

type CodePointRange = readonly [number, number]

/** C0/C1 control characters other than tab (0x09) and newline (0x0A), plus
 *  the bidi override characters -- every bound is a numeric code point,
 *  never a literal character, so this source file stays plain ASCII. A
 *  tool result is attacker-influenced text: an ANSI escape run renders as
 *  garbage, and a bidi override silently reverses how a path or command
 *  reads. */
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

/** How far past the characters still needed each sanitize slice reaches, so
 *  a slice holding a few stripped control/bidi characters still fills `cap`
 *  in one pass instead of immediately needing another. */
const CAP_SLACK = 256

export function capPayload(text: string, cap: number = MAX_PAYLOAD_CHARS): Payload {
  // Sanitizing advances in bounded slices rather than over the whole string,
  // so a large tool result (the ticket anticipates "tens of KB", e.g. a big
  // `git log`) never pays the full pass for content that is discarded past
  // `cap` anyway. Reading has to continue while the kept text is still short
  // of `cap`: sanitizing can strip an arbitrary amount of any one slice --
  // control-heavy output is exactly what it defends against -- and stopping
  // after a fixed prefix would return fewer than `cap` characters while real
  // content still followed. Each slice ends at least `CAP_SLACK` past the
  // last, so the loop advances and the total work stays linear in what is
  // actually read.
  let read = 0
  let sanitized = ''
  while (sanitized.length <= cap && read < text.length) {
    const next = Math.min(text.length, read + (cap - sanitized.length) + CAP_SLACK)
    sanitized += sanitize(text.slice(read, next))
    read = next
  }

  // The never-read remainder is counted raw, so `omittedChars` can slightly
  // over-count when that tail holds characters sanitizing would have
  // stripped -- an approximate count of unread input, deliberately, rather
  // than an exact one bought with the full O(n) pass this avoids.
  const rawRemainder = text.length - read
  if (sanitized.length > cap) return { text: sanitized.slice(0, cap), omittedChars: rawRemainder + (sanitized.length - cap) }
  return { text: sanitized, omittedChars: rawRemainder }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** `Bash` -> first line of `command`; `Read`/`Write`/`Edit`/`NotebookEdit` ->
 *  `file_path`, relative to `cwd` when it sits under it; `Grep` -> `pattern`
 *  then `path`; `Glob` -> `pattern`; `Task` -> `description`; `TodoWrite` ->
 *  the todo count; `WebFetch` -> `url`; anything else -> the first
 *  string-valued input field, else the tool name alone. Capped at 200
 *  characters. */
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

  // Sanitized after the tool-specific extraction, same as every other
  // rendered field -- the headline is the one line that is always visible
  // without expanding a `<details>`, so it is the sink a bidi override or
  // control character would reach first (R4-M1). `sanitize` can only
  // shrink the string, so the length cap still applies after.
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

/** A `tool_result`'s `content` is either a plain string or an array of
 *  sub-blocks (text and, sometimes, an image) -- array-form is joined into
 *  one payload, with an image replaced by a placeholder rather than a
 *  `data:` URL the CSP would otherwise permit. */
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

/** Derives a `FileDiff` from an Edit/Write/NotebookEdit's sibling
 *  `toolUseResult`. `structuredPatch`'s lines already carry their leading
 *  `+`/`-`/space, so `text` is kept verbatim and `sign` is derived for
 *  styling. A `Write` create carries an empty `structuredPatch` (observed on
 *  a real transcript), so that case synthesizes one all-additions hunk from
 *  the paired `tool_use`'s own `input.content` instead. */
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

/** Walks already-parsed `.jsonl` records in order, pairing each `tool_use`
 *  with the `tool_result` that later carries its `tool_use_id` by id, never
 *  by position -- a record this module cannot recognize (missing `uuid`,
 *  an unknown `type`) is skipped rather than thrown on, since a transcript
 *  is untrusted input from disk. */
export function deriveEntries(records: readonly unknown[], options: DeriveEntriesOptions = DEFAULT_OPTIONS): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const pendingIndexById = new Map<string, number>()
  const rawInputById = new Map<string, unknown>()

  for (const raw of records) {
    if (!isRecord(raw)) continue
    const uuid = raw['uuid']
    const timestamp = raw['timestamp']
    if (typeof uuid !== 'string' || typeof timestamp !== 'string') continue

    if (raw['type'] === 'attachment') {
      const entry: MetaEntry = { type: 'meta', uuid, timestamp, label: attachmentLabel(raw['attachment']) }
      entries.push(entry)
      continue
    }

    const message = raw['message']
    if (!isRecord(message)) continue
    const role = message['role']
    const content = message['content']

    if (typeof content === 'string') {
      if (role === 'user') entries.push({ type: 'user-text', uuid, timestamp, text: capPayload(content) })
      else if (role === 'assistant') entries.push({ type: 'assistant-text', uuid, timestamp, text: capPayload(content) })
      continue
    }

    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isRecord(block)) continue
      const blockType = block['type']

      if (blockType === 'text' && typeof block['text'] === 'string') {
        entries.push({ type: role === 'user' ? 'user-text' : 'assistant-text', uuid, timestamp, text: capPayload(block['text']) })
        continue
      }

      if (blockType === 'thinking' && typeof block['thinking'] === 'string') {
        entries.push({ type: 'thinking', uuid, timestamp, text: capPayload(block['thinking']) })
        continue
      }

      if (blockType === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
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
        pendingIndexById.set(block['id'], entries.length)
        rawInputById.set(block['id'], input)
        entries.push(entry)
        continue
      }

      if (blockType === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        const idx = pendingIndexById.get(block['tool_use_id'])
        if (idx === undefined) continue
        const existing = entries[idx]
        if (existing === undefined || existing.type !== 'tool-call') continue

        const isError = block['is_error'] === true
        const payload = capPayload(resultTextOf(block['content']))
        const diff = diffFromToolUseResult(raw['toolUseResult'], rawInputById.get(block['tool_use_id']))

        entries[idx] = { ...existing, result: { isError, payload }, diff }
      }
    }
  }

  return entries
}

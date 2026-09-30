// openTranscript/advanceTranscript (#84): a byte cursor replaces #83's
// one-shot readTranscript. openTranscript's `read` arm stays byte-identical
// to #83's own contract -- same validation order, same containment
// assertion, same failure kinds, same counted-never-dropped malformedLines
// -- but it now loops readLinesFrom from offset 0 to EOF instead of
// streaming through readLines, which is what yields the cursor's starting
// offset. advanceTranscript reads one more bounded chunk from that offset
// and pushes it through the same Deriver the cursor already holds, so a
// tool_use at the end of one chunk still pairs with its tool_result at the
// start of the next.
import { readLinesFrom, statPath } from '../platform'
import type { ReadLinesFromResult } from '../platform'
import type { EntryPatch, TranscriptEntry, TranscriptRead, TranscriptSource } from '../../shared/sessions/transcript'
import { buildProjectIndex, defaultClaudeHome, resolveTranscriptPath, SESSION_ID_RE } from './locate'
import type { ProjectIndex } from './locate'
import { createDeriver } from './transcript-entries'
import type { Deriver } from './transcript-entries'

export interface OpenTranscriptParams {
  readonly sessionId: string
  readonly agentId: string | null
  readonly claudeHome?: string
  /** Skips this call's own `buildProjectIndex` when the caller already built
   *  one -- `main/search/query.ts` builds a single index up front and passes
   *  it into every `openTranscript` call in its scan, rather than re-listing
   *  `<claudeHome>/projects/` once per transcript. */
  readonly index?: ProjectIndex
}

/** `agent-<id>` basenames on this machine run 6-64 lowercase-hex characters
 *  -- validated before any filesystem call, the same "gate first" contract
 *  `SESSION_ID_RE` already holds for the session id. */
const AGENT_ID_RE = /^[0-9a-f]{6,64}$/i

/** Enforced cumulatively -- on the open loop's running offset and on every
 *  poll's `stat` size -- now that the streamed `readLines` abort this used
 *  to ride on is gone. Comfortably above every transcript observed so far
 *  (15.5 MB, 10,114 records), small enough that a runaway file cannot grow
 *  the main process's memory unbounded. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

/** Starting window for one open-loop iteration's or one poll's buffer -- the
 *  largest transcript observed opens in two chunks at this size. Not a hard
 *  ceiling: `readChunkWithRetry` doubles past it, up to what remains of
 *  `MAX_TRANSCRIPT_BYTES`, when a single line doesn't fit. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

const INVALID_ID_MESSAGE = "That session or agent id isn't a valid identifier."

/** `readLinesFrom` reports `too-large` when no newline falls inside the
 *  window it was given -- a single JSONL record (e.g. a `Write` tool call
 *  embedding a large file) can easily outrun `MAX_CHUNK_BYTES` while the
 *  transcript as a whole stays well under `MAX_TRANSCRIPT_BYTES`. Rather than
 *  hard-failing the whole read on that one stuck line, retry the same
 *  offset with a doubled window, capped at `remainingBudget` (what is left
 *  of the transcript-level cap from this offset) -- so a record between
 *  `MAX_CHUNK_BYTES` and `MAX_TRANSCRIPT_BYTES` still reads, and only a
 *  line that would blow the transcript's own budget still reports
 *  `too-large`. */
async function readChunkWithRetry(path: string, offset: number, remainingBudget: number): Promise<ReadLinesFromResult> {
  let windowBytes = Math.min(MAX_CHUNK_BYTES, remainingBudget)
  while (true) {
    const chunk = await readLinesFrom(path, offset, { maxBytes: windowBytes })
    if (chunk.ok || chunk.kind !== 'too-large' || windowBytes >= remainingBudget) return chunk
    windowBytes = Math.min(windowBytes * 2, remainingBudget)
  }
}

function firstCwdOf(records: readonly unknown[]): string | null {
  for (const raw of records) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const cwd = (raw as Record<string, unknown>)['cwd']
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  return null
}

function parseLines(lines: readonly string[]): { readonly records: unknown[]; readonly malformed: number } {
  const records: unknown[] = []
  let malformed = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      malformed += 1
    }
  }
  return { records, malformed }
}

/** Main-process-only -- never crosses IPC. Holds the `Deriver` that keeps
 *  the pairing state (a `tool_use` in one poll's chunk still finds its
 *  `tool_result` in the next), plus everything `advanceTranscript` needs to
 *  resume: the byte offset to read from next, the absolute entry index the
 *  next `appended` row starts at, and the running record/malformed-line
 *  counts a poll's response folds into `TranscriptSource`. */
export interface TranscriptCursor {
  readonly path: string
  readonly sessionId: string
  readonly agentId: string | null
  readonly offset: number
  readonly nextIndex: number
  readonly recordCount: number
  readonly malformedLines: number
  readonly deriver: Deriver
}

export interface OpenTranscriptResult {
  readonly read: TranscriptRead
  readonly cursor: TranscriptCursor | null
}

/** Validates ids, resolves the path through the project index, then loops
 *  `readChunkWithRetry` from `0` to EOF (`MAX_CHUNK_BYTES` at a time, widening
 *  only when a stuck line demands it) rather than the old single streamed
 *  read -- what yields both the entries this first render needs and the
 *  cursor a later `advanceTranscript` resumes from. `cwd` is resolved from
 *  the accumulated raw records *before* the deriver is constructed, and
 *  never adopted again after -- a later record carrying a different `cwd`
 *  (which should not happen, but this is untrusted input) never re-bases an
 *  in-flight headline. */
export async function openTranscript(params: OpenTranscriptParams): Promise<OpenTranscriptResult> {
  const { sessionId, agentId } = params

  if (!SESSION_ID_RE.test(sessionId) || (agentId !== null && !AGENT_ID_RE.test(agentId))) {
    return { read: { ok: false, kind: 'invalid-id', message: INVALID_ID_MESSAGE, path: null }, cursor: null }
  }

  const claudeHome = params.claudeHome ?? defaultClaudeHome()

  let index: ProjectIndex
  if (params.index !== undefined) {
    index = params.index
  } else {
    const indexResult = await buildProjectIndex(claudeHome)
    if (!indexResult.ok) {
      return { read: { ok: false, kind: 'session-unresolved', message: indexResult.message, path: null }, cursor: null }
    }
    index = indexResult.index
  }

  const resolved = resolveTranscriptPath(sessionId, agentId, index)
  if (!resolved.ok) {
    if (resolved.kind === 'invalid-id') return { read: { ok: false, kind: 'invalid-id', message: INVALID_ID_MESSAGE, path: null }, cursor: null }
    return { read: { ok: false, kind: 'session-unresolved', message: `No project directory resolves session ${sessionId}`, path: null }, cursor: null }
  }
  const path = resolved.path

  const stat = await statPath(path)
  if (!stat.ok) {
    if (stat.kind === 'not-found') return { read: { ok: false, kind: 'not-found', message: `No transcript file at ${path}.`, path }, cursor: null }
    return { read: { ok: false, kind: 'unreadable', message: stat.message, path }, cursor: null }
  }

  const rawRecords: unknown[] = []
  let malformedLines = 0
  let offset = 0

  while (true) {
    const chunk = await readChunkWithRetry(path, offset, MAX_TRANSCRIPT_BYTES - offset)
    if (!chunk.ok) {
      if (chunk.kind === 'too-large') return { read: { ok: false, kind: 'too-large', message: chunk.message, path }, cursor: null }
      if (chunk.kind === 'not-found') return { read: { ok: false, kind: 'not-found', message: `No transcript file at ${path}.`, path }, cursor: null }
      return { read: { ok: false, kind: 'unreadable', message: chunk.message, path }, cursor: null }
    }

    const { records, malformed } = parseLines(chunk.value.lines)
    rawRecords.push(...records)
    malformedLines += malformed
    offset += chunk.value.bytesConsumed

    if (offset > MAX_TRANSCRIPT_BYTES) {
      return { read: { ok: false, kind: 'too-large', message: `${path} exceeds the ${MAX_TRANSCRIPT_BYTES}-byte cap`, path }, cursor: null }
    }
    if (!chunk.value.filledBudget) break
  }

  const cwd = firstCwdOf(rawRecords)
  const deriver = createDeriver({ cwd })
  const { appended, patched } = deriver.push(rawRecords)
  const entries: TranscriptEntry[] = appended.slice()
  for (const patch of patched) entries[patch.index] = patch.entry

  const source: TranscriptSource = {
    sessionId,
    agentId,
    path,
    sizeBytes: stat.value.size,
    modifiedAt: stat.value.modifiedAt,
    recordCount: rawRecords.length,
    malformedLines,
  }

  return {
    read: { ok: true, source, entries },
    cursor: { path, sessionId, agentId, offset, nextIndex: entries.length, recordCount: rawRecords.length, malformedLines, deriver },
  }
}

export type AdvanceTranscriptResult =
  | {
      readonly ok: true
      readonly appended: readonly TranscriptEntry[]
      readonly patched: readonly EntryPatch[]
      readonly source: TranscriptSource
      readonly cursor: TranscriptCursor
      readonly hasMore: boolean
    }
  | { readonly ok: false; readonly kind: 'not-found' | 'unreadable' | 'too-large' | 'truncated'; readonly message: string; readonly path: string }

/** Reads at most one chunk (via `readChunkWithRetry`, starting at
 *  `MAX_CHUNK_BYTES` and widening only when a stuck line demands it) starting
 *  at `cursor.offset` and pushes it through the cursor's own `Deriver`.
 *  `hasMore` is `true` only when this chunk filled the whole (possibly
 *  widened) window -- the caller's signal to poll again on the next
 *  macrotask rather than waiting the full interval, so a big catch-up drains
 *  fast without blocking paint.
 *
 *  Direction of failure -- a stale cursor re-opens, it never goes quiet.
 *  `size < cursor.offset` (the file was rewritten or compacted) reports
 *  `truncated` rather than reading a chunk against an offset the current
 *  file can no longer support; the caller re-opens from the start. Idle is
 *  never reported as finished: a poll with no new bytes returns empty
 *  `appended`/`patched` and nothing else. */
export async function advanceTranscript(cursor: TranscriptCursor): Promise<AdvanceTranscriptResult> {
  const stat = await statPath(cursor.path)
  if (!stat.ok) {
    if (stat.kind === 'not-found') return { ok: false, kind: 'not-found', message: `No transcript file at ${cursor.path}.`, path: cursor.path }
    return { ok: false, kind: 'unreadable', message: stat.message, path: cursor.path }
  }

  if (stat.value.size < cursor.offset) {
    return { ok: false, kind: 'truncated', message: `${cursor.path} is now smaller than the last position read.`, path: cursor.path }
  }
  if (stat.value.size > MAX_TRANSCRIPT_BYTES) {
    return { ok: false, kind: 'too-large', message: `${cursor.path} exceeds the ${MAX_TRANSCRIPT_BYTES}-byte cap`, path: cursor.path }
  }

  const chunk = await readChunkWithRetry(cursor.path, cursor.offset, MAX_TRANSCRIPT_BYTES - cursor.offset)
  if (!chunk.ok) {
    if (chunk.kind === 'not-found') return { ok: false, kind: 'not-found', message: `No transcript file at ${cursor.path}.`, path: cursor.path }
    if (chunk.kind === 'too-large') return { ok: false, kind: 'too-large', message: chunk.message, path: cursor.path }
    return { ok: false, kind: 'unreadable', message: chunk.message, path: cursor.path }
  }

  const { records, malformed } = parseLines(chunk.value.lines)
  const nextOffset = cursor.offset + chunk.value.bytesConsumed
  if (nextOffset > MAX_TRANSCRIPT_BYTES) {
    return { ok: false, kind: 'too-large', message: `${cursor.path} exceeds the ${MAX_TRANSCRIPT_BYTES}-byte cap`, path: cursor.path }
  }

  const { appended, patched } = cursor.deriver.push(records)

  const nextCursor: TranscriptCursor = {
    path: cursor.path,
    sessionId: cursor.sessionId,
    agentId: cursor.agentId,
    offset: nextOffset,
    nextIndex: cursor.nextIndex + appended.length,
    recordCount: cursor.recordCount + records.length,
    malformedLines: cursor.malformedLines + malformed,
    deriver: cursor.deriver,
  }

  const source: TranscriptSource = {
    sessionId: cursor.sessionId,
    agentId: cursor.agentId,
    path: cursor.path,
    sizeBytes: stat.value.size,
    modifiedAt: stat.value.modifiedAt,
    recordCount: nextCursor.recordCount,
    malformedLines: nextCursor.malformedLines,
  }

  return { ok: true, appended, patched, source, cursor: nextCursor, hasMore: chunk.value.filledBudget }
}

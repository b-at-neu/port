// readTranscript (#83): validate ids, resolve the path through the project
// index, stream the file, and project every parseable line into renderer-safe
// entries — never buffering the whole file as one string (the largest
// transcript observed on the author's machine is 15.5 MB across 10,114
// records, already inside the 64 MB cap this reader enforces).
import { readLines, statPath } from '../platform'
import type { TranscriptRead } from '../../shared/sessions/transcript'
import { buildProjectIndex, defaultClaudeHome, resolveTranscriptPath, SESSION_ID_RE } from './locate'
import { deriveEntries } from './transcript-entries'

export interface ReadTranscriptParams {
  readonly sessionId: string
  readonly agentId: string | null
  readonly claudeHome?: string
}

/** `agent-<id>` basenames on this machine run 6-64 lowercase-hex characters
 *  — validated before any filesystem call, the same "gate first" contract
 *  `SESSION_ID_RE` already holds for the session id. */
const AGENT_ID_RE = /^[0-9a-f]{6,64}$/i

/** Past this, `readLines` aborts the stream rather than buffering further —
 *  comfortably above every transcript observed so far, and small enough that
 *  a runaway file cannot grow the main process's memory unbounded. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

const INVALID_ID_MESSAGE = "That session or agent id isn't a valid identifier."

function firstCwdOf(records: readonly unknown[]): string | null {
  for (const raw of records) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const cwd = (raw as Record<string, unknown>)['cwd']
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  return null
}

export async function readTranscript(params: ReadTranscriptParams): Promise<TranscriptRead> {
  const { sessionId, agentId } = params

  if (!SESSION_ID_RE.test(sessionId) || (agentId !== null && !AGENT_ID_RE.test(agentId))) {
    return { ok: false, kind: 'invalid-id', message: INVALID_ID_MESSAGE, path: null }
  }

  const claudeHome = params.claudeHome ?? defaultClaudeHome()

  const indexResult = await buildProjectIndex(claudeHome)
  if (!indexResult.ok) {
    return { ok: false, kind: 'session-unresolved', message: indexResult.message, path: null }
  }

  const resolved = resolveTranscriptPath(sessionId, agentId, indexResult.index)
  if (!resolved.ok) {
    if (resolved.kind === 'invalid-id') return { ok: false, kind: 'invalid-id', message: INVALID_ID_MESSAGE, path: null }
    return { ok: false, kind: 'session-unresolved', message: `No project directory resolves session ${sessionId}`, path: null }
  }
  const path = resolved.path

  const stat = await statPath(path)
  if (!stat.ok) {
    if (stat.kind === 'not-found') return { ok: false, kind: 'not-found', message: `No transcript file at ${path}.`, path }
    return { ok: false, kind: 'unreadable', message: stat.message, path }
  }

  const rawRecords: unknown[] = []
  let malformedLines = 0
  const linesResult = await readLines(
    path,
    (line) => {
      const trimmed = line.trim()
      if (trimmed === '') return
      try {
        rawRecords.push(JSON.parse(trimmed))
      } catch {
        malformedLines += 1
      }
    },
    { maxBytes: MAX_TRANSCRIPT_BYTES },
  )
  if (!linesResult.ok) {
    if (linesResult.kind === 'too-large') return { ok: false, kind: 'too-large', message: linesResult.message, path }
    if (linesResult.kind === 'not-found') return { ok: false, kind: 'not-found', message: `No transcript file at ${path}.`, path }
    return { ok: false, kind: 'unreadable', message: linesResult.message, path }
  }

  const cwd = firstCwdOf(rawRecords)
  const entries = deriveEntries(rawRecords, { cwd })

  return {
    ok: true,
    source: {
      sessionId,
      agentId,
      path,
      sizeBytes: stat.value.size,
      modifiedAt: stat.value.modifiedAt,
      recordCount: rawRecords.length,
      malformedLines,
    },
    entries,
  }
}

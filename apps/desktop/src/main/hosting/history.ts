// Reads and slices the earlier conversation for resume/resume-at/fork — read before spawn, kept frozen on the handle.
import type { SessionHistory, SessionStartMode } from '../../shared/hosting/types'
import { openTranscript } from '../sessions/transcript'
import type { OpenTranscriptParams } from '../sessions/transcript'

/** The last `HISTORY_LIMIT` entries are kept; the rest are counted as `omittedBefore`, never silently dropped. */
export const HISTORY_LIMIT = 500

const RESUME_POINT_MESSAGE = "The resume point isn't in the transcript."

export interface ReadHistoryDeps {
  readonly openTranscript: (params: OpenTranscriptParams) => ReturnType<typeof openTranscript>
}

export const defaultReadHistoryDeps: ReadHistoryDeps = { openTranscript }

/** `fresh` reads nothing. `resume`/`fork` read the whole transcript; `resume-at` cuts after the last entry whose `uuid` matches, failing (never aborting the session) when that uuid isn't present. A read failure is also reported rather than thrown, so the session still starts. */
export async function readHistory(mode: SessionStartMode, deps: ReadHistoryDeps = defaultReadHistoryDeps): Promise<SessionHistory> {
  if (mode.kind === 'fresh') return { kind: 'none' }

  const result = await deps.openTranscript({ sessionId: mode.sessionId, agentId: null })
  if (!result.read.ok) return { kind: 'failed', message: result.read.message }

  let entries = result.read.entries
  if (mode.kind === 'resume-at') {
    const cutIndex = entries.findIndex((entry) => entry.uuid === mode.messageUuid)
    if (cutIndex === -1) return { kind: 'failed', message: RESUME_POINT_MESSAGE }
    entries = entries.slice(0, cutIndex + 1)
  }

  const omittedBefore = Math.max(0, entries.length - HISTORY_LIMIT)
  const kept = omittedBefore > 0 ? entries.slice(omittedBefore) : entries
  return { kind: 'loaded', entries: kept, omittedBefore, sourceSessionId: mode.sessionId }
}

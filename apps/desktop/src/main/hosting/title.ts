// #103: pure title resolution — `promptTitle` for a fresh session's first
// send, `recordTitle` for the disk record a resume/fork's title comes from,
// and `resolveStartTitle` composing the two before spawn so the rail never
// shows a bare session id while `init` is still in flight. `sanitize` comes
// through the `../sessions` barrel (#219's own rule for this directory),
// never a second control/bidi stripper.
import { sanitize } from '../sessions/transcript-entries'
import type { RawSession, SessionReader } from '../sessions/sdk'
import { forkTitle } from './fork'
import type { SessionStartMode } from '../../shared/hosting/types'

const MAX_TITLE_LENGTH = 60

/** Sanitized, whitespace-collapsed, capped at `MAX_TITLE_LENGTH` with `…` —
 *  `null` when nothing is left after trimming, never an empty string. */
function normalize(text: string): string | null {
  const collapsed = sanitize(text).replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  return collapsed.length > MAX_TITLE_LENGTH ? `${collapsed.slice(0, MAX_TITLE_LENGTH)}…` : collapsed
}

/** A fresh session's own title source: the first prompt it was sent. */
export function promptTitle(text: string): string | null {
  return normalize(text)
}

/** A resumed or forked session's title source: the disk record's own
 *  `customTitle ?? summary ?? firstPrompt`, same normalization. */
export function recordTitle(record: Pick<RawSession, 'customTitle' | 'summary' | 'firstPrompt'>): string | null {
  const raw = record.customTitle ?? record.summary ?? record.firstPrompt
  return raw === null ? null : normalize(raw)
}

/** Resolves the title a `resume`/`resume-at`/`fork` start should carry
 *  before `init` ever arrives — `fresh` always resolves `null` (there is
 *  nothing to read yet; `promptTitle` takes over on the first `send()`). A
 *  reader failure, or a target the reader no longer lists, resolves `null`
 *  rather than throwing — a missing title is never fatal to starting the
 *  session itself. */
export async function resolveStartTitle(mode: SessionStartMode, listSessions: SessionReader): Promise<string | null> {
  if (mode.kind === 'fresh') return null
  try {
    const result = await listSessions()
    if (!result.ok) return null
    const target = result.sessions.find((session) => session.sessionId === mode.sessionId)
    if (target === undefined) return null
    if (mode.kind === 'fork') {
      const parentTitle = recordTitle(target)
      return parentTitle === null ? null : forkTitle(parentTitle)
    }
    return recordTitle(target)
  } catch {
    return null
  }
}

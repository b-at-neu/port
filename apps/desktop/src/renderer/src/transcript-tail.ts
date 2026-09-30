// The transcript screen's live-follow session (#83, #84), split out of
// main.ts (#87) once the search screen's own routing pushed it past
// ENGINEERING §7's 500-line limit -- the same "main.ts delegates rather than
// owning this state itself" split `board/actions.ts` and `search.ts` already
// draw. Owns `TranscriptViewState` and the polling `TailSession`; main.ts
// only calls in and registers a redraw callback.
import type { TranscriptTailFailureKind } from '../../shared/sessions/transcript'
import { applyTailDelta, setFollowingIndicator } from './transcript'
import type { TranscriptViewState } from './transcript'
import { clearTailBanner, showTailBanner, showTruncatedNote } from './transcript-banner'
import type { TailBannerKind } from './transcript-banner'

let transcriptState: TranscriptViewState = { status: 'loading' }
let redraw: () => void = () => {}

/** Registered once by `main.ts` -- every state change below calls this
 *  rather than main.ts polling `transcriptScreenState()` on a timer. */
export function registerTranscriptRedraw(fn: () => void): void {
  redraw = fn
}

export function transcriptScreenState(): TranscriptViewState {
  return transcriptState
}

/** Following polls at a floor of one second — a local `fs.stat`, never a
 *  network call, so there is no pacing ladder here (`ENGINEERING §6`'s
 *  ladder is about the cockpit's GitHub tick): backing off would only add
 *  latency exactly when an idle agent wakes back up. */
const TAIL_INTERVAL_MS = 1000

/** The live follow session for whichever transcript is on screen — `null`
 *  outside the transcript view. Closed on every navigation away and
 *  replaced (never merged) on every re-open, so a superseded poll's
 *  response is dropped by the `tailId` check in `pollTranscriptTail`. */
interface TailSession {
  readonly tailId: string
  following: boolean
  timer: ReturnType<typeof setTimeout> | null
}

let tailSession: TailSession | null = null

/** What a `truncated`/`unknown-tail` poll re-opens from -- tracked here
 *  rather than read off main.ts's own `View`, since this module no longer
 *  has one. */
let currentTarget: { readonly sessionId: string; readonly agentId: string | null; readonly title: string } | null = null

function stopTailTimer(): void {
  if (tailSession?.timer != null) {
    clearTimeout(tailSession.timer)
    tailSession.timer = null
  }
}

function scheduleNextPoll(delayMs: number): void {
  if (tailSession === null || !tailSession.following || document.hidden) return
  const session = tailSession
  session.timer = setTimeout(() => void pollTranscriptTail(session.tailId), delayMs)
}

export function closeTranscriptTail(): void {
  stopTailTimer()
  currentTarget = null
  if (tailSession === null) return
  const { tailId } = tailSession
  tailSession = null
  window.port.transcriptTailClose({ tailId }).catch((error: unknown) => {
    console.error('Failed to close a transcript tail', error)
  })
}

/** `invalid-id`/`session-unresolved` cannot occur once a tail has already
 *  opened successfully once — the id never changes underneath a follow
 *  session — so they fold into `unreadable` defensively rather than adding
 *  a banner copy no real poll ever produces. */
function toBannerKind(kind: TranscriptTailFailureKind): TailBannerKind {
  if (kind === 'not-found' || kind === 'unreadable' || kind === 'too-large') return kind
  return 'unreadable'
}

export async function openTranscriptTail(sessionId: string, agentId: string | null, title: string, focusIndex: number | null): Promise<void> {
  currentTarget = { sessionId, agentId, title }
  transcriptState = { status: 'loading' }
  redraw()
  try {
    const opened = await window.port.transcriptTailOpen({ sessionId, agentId })
    if (!opened.ok) {
      transcriptState = { status: 'error', kind: opened.kind, message: opened.message, path: opened.path }
      tailSession = null
      redraw()
      return
    }
    transcriptState = { status: 'ready', source: opened.source, entries: opened.entries, title, focusIndex }
    redraw()
    tailSession = { tailId: opened.tailId, following: true, timer: null }
    scheduleNextPoll(TAIL_INTERVAL_MS)
  } catch (error) {
    console.error('Failed to open a transcript tail', error)
    tailSession = null
    transcriptState = { status: 'unreachable' }
    redraw()
  }
}

/** `truncated`/`unknown-tail` both mean "the cursor no longer applies" —
 *  re-open from the start rather than reporting either as a banner, which
 *  an operator would misread as the agent having stopped. Only `truncated`
 *  leaves a trace: one dim note once the fresh render lands. Never
 *  re-focuses -- a focus scroll is a one-time thing on the hit that opened
 *  this transcript, not on every reconnect. */
async function reopenTranscriptTail(noteTruncation: boolean): Promise<void> {
  if (currentTarget === null) return
  const { sessionId, agentId, title } = currentTarget
  await openTranscriptTail(sessionId, agentId, title, null)
  if (noteTruncation) showTruncatedNote()
}

export function pauseFollowing(): void {
  if (tailSession === null) return
  tailSession.following = false
  stopTailTimer()
  setFollowingIndicator(false)
}

/** Shared by the follow toggle's resume and the error banner's `Retry` —
 *  both mean "poll again right now". */
export function resumeFollowing(): void {
  if (tailSession === null) return
  tailSession.following = true
  setFollowingIndicator(true)
  clearTailBanner()
  void pollTranscriptTail(tailSession.tailId)
}

export function toggleFollow(): void {
  if (tailSession === null) return
  if (tailSession.following) pauseFollowing()
  else resumeFollowing()
}

async function pollTranscriptTail(tailId: string): Promise<void> {
  if (tailSession === null || tailSession.tailId !== tailId) return // superseded by a navigation or a re-open
  try {
    const polled = await window.port.transcriptTailPoll({ tailId })
    if (tailSession === null || tailSession.tailId !== tailId) return

    if (!polled.ok) {
      if (polled.kind === 'unknown-tail') {
        await reopenTranscriptTail(false)
        return
      }
      if (polled.kind === 'truncated') {
        await reopenTranscriptTail(true)
        return
      }
      pauseFollowing()
      showTailBanner(toBannerKind(polled.kind), polled.message, polled.path)
      return
    }

    clearTailBanner()
    applyTailDelta({ appended: polled.appended, patched: polled.patched, source: polled.source })
    scheduleNextPoll(polled.hasMore ? 0 : TAIL_INTERVAL_MS)
  } catch (error) {
    console.error('Failed to poll a transcript tail', error)
    pauseFollowing()
    showTailBanner('unreachable', 'Lost contact with the main process.', null)
  }
}

/** `document.addEventListener('visibilitychange', ...)`'s whole body — a
 *  no-op outside an open transcript, since `tailSession` is only non-null
 *  while one is on screen. */
export function handleVisibilityChange(): void {
  if (tailSession === null) return
  if (document.hidden) {
    stopTailTimer()
  } else if (tailSession.following) {
    void pollTranscriptTail(tailSession.tailId) // poll once immediately on return
  }
}

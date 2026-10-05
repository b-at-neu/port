// #219: a pure projector turning the live SDK message stream into the same
// `TranscriptEntry` shape #83/#84 already derive from a session's on-disk
// `.jsonl` — one normalizer, one renderer, never a second pairing
// implementation (the three-renderers trap #123 flagged). It narrows every
// message structurally (`isRecord`), never trusting the SDK's own declared
// types at runtime, and never throws — a message this projector cannot
// recognize is skipped, the same "untrusted input from disk" posture
// `transcript-entries.ts` already takes with a real transcript.
//
// A live session's message is not a `.jsonl` record: a `tool_use_result` on
// disk is `tool_use_result` (snake_case) on the wire, and the deriver's own
// pairing state (`createDeriver`) is reused unchanged by feeding it records
// shaped exactly like the on-disk ones this app already parses. Meta rows
// (turn complete, denials, retries, compaction) are never on disk in this
// shape, so they are built directly here and interleaved into the same
// absolute index space the deriver's own `appended`/`patched` occupy.
import type { EntryPatch, MetaEntry, TranscriptEntry } from '../../shared/sessions/transcript'
import { MAX_PAYLOAD_CHARS } from '../../shared/sessions/transcript'
import { isRecord } from '../../shared/guards'
import { createDeriver, sanitize } from '../sessions/transcript-entries'
import type { LiveBlock, LiveBlockKind, PartialUpdate, SessionEntriesDelta } from '../../shared/hosting/types'

export interface CreateSessionProjectorParams {
  /** The session's own `cwd` — passed straight through to `createDeriver`,
   *  used only to shorten a headline path, never to resolve or open
   *  anything. */
  readonly cwd: string
}

/** The bounded ring's size — a live session's window, never a growing
 *  per-session array (the same "small, focused" memory rule `REPLAY_LIMIT`
 *  already applies to the raw envelope ring). */
export const ENTRY_RETAIN_LIMIT = 500

/** `push`/`recordSend`'s own return shape — everything `SessionEntriesDelta`
 *  carries except `sessionKey`, which only `handle.ts` (the one caller that
 *  knows it) adds. */
export type ProjectedDelta = Omit<SessionEntriesDelta, 'sessionKey'>

export interface SessionProjectorWindow {
  readonly entries: readonly TranscriptEntry[]
  /** The absolute index of `entries[0]` — `0` when nothing has ever been
   *  evicted, greater once the ring has dropped its oldest rows. */
  readonly firstIndex: number
  readonly partial: LiveBlock | null
  readonly pendingSends: readonly string[]
  readonly revision: number
}

export interface SessionProjector {
  /** Narrows one raw SDK message and folds it into this projector's state,
   *  returning this call's own delta — `null` when the message produced no
   *  visible change (an unrecognized type, a subagent frame, a mid-stream
   *  event that isn't a text/thinking delta). Never throws: a message this
   *  projector cannot make sense of is skipped, the same untrusted-input
   *  posture the on-disk deriver already takes. */
  push(message: unknown, receivedAt: string): ProjectedDelta | null
  /** Pushes the operator's own turn through the same deriver a `user-text`
   *  record on disk would produce, and marks its uuid pending until an
   *  `assistant`/`stream_event` frame or a `result` acknowledges it. */
  recordSend(uuid: string, text: string, at: string): ProjectedDelta
  /** The current bounded state — what `session:attach` hands a reconnecting
   *  renderer. */
  window(): SessionProjectorWindow
}

/** `user_message_uuids ?? [user_message_uuid]`, the exact fallback the plan
 *  states — every ack site (an `assistant` frame, the first `stream_event`
 *  of a turn) reads it the same way. */
function ackUuidsOf(message: Record<string, unknown>): readonly string[] {
  const many = message['user_message_uuids']
  if (Array.isArray(many)) return many.filter((item): item is string => typeof item === 'string')
  const one = message['user_message_uuid']
  return typeof one === 'string' ? [one] : []
}

function metaEntry(uuid: string, timestamp: string, label: string): MetaEntry {
  return { type: 'meta', uuid, timestamp, label: sanitize(label) }
}

function formatSeconds(durationMs: unknown): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '0.0 s'
  return `${(durationMs / 1000).toFixed(1)} s`
}

export function createSessionProjector(params: CreateSessionProjectorParams): SessionProjector {
  const deriver = createDeriver({ cwd: params.cwd })

  // The merged absolute-index window — deriver-produced entries and
  // directly-built meta rows share one sequence, so a renderer holding
  // `appended` in arrival order needs no second numbering.
  let ring: TranscriptEntry[] = []
  let firstIndex = 0
  let nextAbsoluteIndex = 0

  // Mirrors the deriver's own running `nextIndex` — it increments exactly
  // once per entry the deriver's own `push` emits, so a patch's `index`
  // (deriver-space) resolves through this map to this projector's absolute
  // space. Held only while a tool call is still open; deleted the moment its
  // result pairs (ENGINEERING's "held only while pending" idiom, same as the
  // deriver's own `pendingById`).
  let mirrorIndex = 0
  const openToolCalls = new Map<number, number>()

  let liveBlock: LiveBlock | null = null
  let liveBlockStopped = false
  let liveMessageId: string | null = null

  const pendingSends = new Set<string>()
  let revision = 0
  let syntheticSeq = 0

  function pushToWindow(entry: TranscriptEntry): number {
    const absoluteIndex = nextAbsoluteIndex
    nextAbsoluteIndex += 1
    ring.push(entry)
    if (ring.length > ENTRY_RETAIN_LIMIT) {
      ring = ring.slice(1)
      firstIndex += 1
    }
    return absoluteIndex
  }

  function patchWindow(absoluteIndex: number, entry: TranscriptEntry): void {
    const relative = absoluteIndex - firstIndex
    // Evicted from the ring already — the patch still crosses the boundary
    // (the caller folds it into this call's own `patched`), it just has
    // nothing left here to overwrite.
    if (relative < 0 || relative >= ring.length) return
    ring[relative] = entry
  }

  /** Folds one deriver `push` result into the window, translating every
   *  patch's deriver-space index through `openToolCalls`. */
  function ingestDerived(appended: readonly TranscriptEntry[], patched: readonly EntryPatch[]): { appended: TranscriptEntry[]; patched: EntryPatch[] } {
    const outAppended: TranscriptEntry[] = []
    for (const entry of appended) {
      const absoluteIndex = pushToWindow(entry)
      if (entry.type === 'tool-call') openToolCalls.set(mirrorIndex, absoluteIndex)
      mirrorIndex += 1
      outAppended.push(entry)
    }
    const outPatched: EntryPatch[] = []
    for (const patch of patched) {
      const absoluteIndex = openToolCalls.get(patch.index)
      openToolCalls.delete(patch.index)
      if (absoluteIndex === undefined) continue
      patchWindow(absoluteIndex, patch.entry)
      outPatched.push({ index: absoluteIndex, entry: patch.entry })
    }
    return { appended: outAppended, patched: outPatched }
  }

  function clearLiveBlock(): PartialUpdate | null {
    if (liveBlock === null) return null
    liveBlock = null
    liveBlockStopped = false
    return { op: 'clear' }
  }

  function ackSends(message: Record<string, unknown>): readonly string[] | null {
    const uuids = ackUuidsOf(message)
    if (uuids.length === 0) return null
    let changed = false
    for (const uuid of uuids) {
      if (pendingSends.delete(uuid)) changed = true
    }
    return changed ? [...pendingSends] : null
  }

  function buildDelta(parts: { appended?: readonly TranscriptEntry[]; patched?: readonly EntryPatch[]; partial?: PartialUpdate | null; pendingSends?: readonly string[] | null }): ProjectedDelta | null {
    const appended = parts.appended ?? []
    const patched = parts.patched ?? []
    const partial = parts.partial ?? null
    const pendingSendsUpdate = parts.pendingSends ?? null
    if (appended.length === 0 && patched.length === 0 && partial === null && pendingSendsUpdate === null) return null
    revision += 1
    return { revision, appended, patched, partial, pendingSends: pendingSendsUpdate }
  }

  function handleAssistant(message: Record<string, unknown>, receivedAt: string): ProjectedDelta | null {
    const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `live-${(syntheticSeq += 1)}`
    const timestamp = typeof message['timestamp'] === 'string' ? message['timestamp'] : receivedAt
    const record = { uuid, timestamp, message: message['message'] }
    const { appended, patched } = deriver.push([record])
    const { appended: outAppended, patched: outPatched } = ingestDerived(appended, patched)

    const pendingSendsUpdate = ackSends(message)
    const partial = liveBlockStopped ? clearLiveBlock() : null

    return buildDelta({ appended: outAppended, patched: outPatched, partial, pendingSends: pendingSendsUpdate })
  }

  function handleUser(message: Record<string, unknown>, receivedAt: string): ProjectedDelta | null {
    // Already recorded by `recordSend` — a replayed echo of our own turn,
    // never a second entry for it.
    if (message['isReplay'] === true) return null

    const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `live-${(syntheticSeq += 1)}`
    const timestamp = typeof message['timestamp'] === 'string' ? message['timestamp'] : receivedAt
    const record: Record<string, unknown> = { uuid, timestamp, message: message['message'] }
    if ('tool_use_result' in message) record['toolUseResult'] = message['tool_use_result']

    const { appended, patched } = deriver.push([record])
    const { appended: outAppended, patched: outPatched } = ingestDerived(appended, patched)
    return buildDelta({ appended: outAppended, patched: outPatched })
  }

  function handleResult(message: Record<string, unknown>, receivedAt: string): ProjectedDelta | null {
    const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `live-${(syntheticSeq += 1)}`
    const timestamp = typeof message['timestamp'] === 'string' ? message['timestamp'] : receivedAt

    const label =
      message['subtype'] === 'success'
        ? `Turn complete · ${formatSeconds(message['duration_ms'])}`
        : (() => {
            const errors = message['errors']
            const first = Array.isArray(errors) && typeof errors[0] === 'string' ? errors[0] : null
            return `Turn ended early · ${String(message['subtype'])}${first !== null ? `: ${first}` : ''}`
          })()

    const partial = clearLiveBlock()

    // Fallback for producers that omit the per-frame ack stamp entirely — a
    // result whose queue is empty (or that names no queue at all) means
    // every send this turn consumed is done, so nothing should still show
    // `Queued`.
    const queuedTurnCount = message['queued_turn_count']
    let pendingSendsUpdate: readonly string[] | null = null
    if ((typeof queuedTurnCount !== 'number' || queuedTurnCount <= 0) && pendingSends.size > 0) {
      pendingSends.clear()
      pendingSendsUpdate = []
    }
    const acked = ackSends(message)
    if (acked !== null) pendingSendsUpdate = acked

    return buildDelta({ appended: [metaEntry(uuid, timestamp, label)], partial, pendingSends: pendingSendsUpdate })
  }

  function handlePermissionDenied(message: Record<string, unknown>, receivedAt: string): ProjectedDelta | null {
    const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `live-${(syntheticSeq += 1)}`
    const toolName = typeof message['tool_name'] === 'string' ? message['tool_name'] : 'tool'
    const denyMessage = typeof message['message'] === 'string' ? message['message'] : ''
    return buildDelta({ appended: [metaEntry(uuid, receivedAt, `Denied ${toolName}: ${denyMessage}`)] })
  }

  function handleApiRetry(message: Record<string, unknown>, receivedAt: string): ProjectedDelta | null {
    const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `live-${(syntheticSeq += 1)}`
    const attempt = typeof message['attempt'] === 'number' ? message['attempt'] : 0
    const maxRetries = typeof message['max_retries'] === 'number' ? message['max_retries'] : 0
    return buildDelta({ appended: [metaEntry(uuid, receivedAt, `Retrying the API request (attempt ${attempt} of ${maxRetries})`)] })
  }

  function handleCompactBoundary(message: Record<string, unknown>, receivedAt: string): ProjectedDelta | null {
    const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `live-${(syntheticSeq += 1)}`
    return buildDelta({ appended: [metaEntry(uuid, receivedAt, 'Context compacted')] })
  }

  function appendToLiveBlock(chunk: string): string | null {
    if (liveBlock === null) return null
    if (liveBlock.text.length >= MAX_PAYLOAD_CHARS) {
      liveBlock = { ...liveBlock, omittedChars: liveBlock.omittedChars + chunk.length }
      return null
    }
    const sanitized = sanitize(chunk)
    const room = MAX_PAYLOAD_CHARS - liveBlock.text.length
    const kept = sanitized.length > room ? sanitized.slice(0, room) : sanitized
    const omitted = sanitized.length - kept.length
    liveBlock = { ...liveBlock, text: liveBlock.text + kept, omittedChars: liveBlock.omittedChars + omitted }
    return kept.length > 0 ? kept : null
  }

  function blockKindOf(contentBlock: unknown): LiveBlockKind | null {
    if (!isRecord(contentBlock)) return null
    return contentBlock['type'] === 'text' ? 'text' : contentBlock['type'] === 'thinking' ? 'thinking' : null
  }

  function handleStreamEvent(message: Record<string, unknown>): ProjectedDelta | null {
    const pendingSendsUpdate = ackSends(message)
    const event = message['event']
    if (!isRecord(event)) return buildDelta({ pendingSends: pendingSendsUpdate })

    const eventType = event['type']
    let partial: PartialUpdate | null = null

    if (eventType === 'message_start') {
      const eventMessage = event['message']
      liveMessageId = isRecord(eventMessage) && typeof eventMessage['id'] === 'string' ? eventMessage['id'] : null
    } else if (eventType === 'content_block_start') {
      const kind = blockKindOf(event['content_block'])
      const index = event['index']
      if (kind !== null && typeof index === 'number' && liveMessageId !== null) {
        liveBlock = { blockId: `${liveMessageId}:${index}`, kind, text: '', omittedChars: 0 }
        liveBlockStopped = false
        partial = { op: 'append', blockId: liveBlock.blockId, kind, text: '' }
      }
    } else if (eventType === 'content_block_delta') {
      const delta = event['delta']
      if (isRecord(delta) && liveBlock !== null) {
        const chunk = delta['type'] === 'text_delta' && typeof delta['text'] === 'string' ? delta['text'] : delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string' ? delta['thinking'] : null
        if (chunk !== null) {
          const appendedText = appendToLiveBlock(chunk)
          if (appendedText !== null) partial = { op: 'append', blockId: liveBlock.blockId, kind: liveBlock.kind, text: appendedText }
        }
      }
    } else if (eventType === 'content_block_stop') {
      liveBlockStopped = true
    }

    return buildDelta({ partial, pendingSends: pendingSendsUpdate })
  }

  return {
    push(message, receivedAt) {
      if (!isRecord(message)) return null
      const parentToolUseId = message['parent_tool_use_id']
      if (typeof parentToolUseId === 'string') return null // subagent traffic — the Task row shows its result

      const type = message['type']
      const subtype = message['subtype']

      if (type === 'assistant') return handleAssistant(message, receivedAt)
      if (type === 'user') return handleUser(message, receivedAt)
      if (type === 'result') return handleResult(message, receivedAt)
      if (type === 'stream_event') return handleStreamEvent(message)
      if (type === 'system' && subtype === 'permission_denied') return handlePermissionDenied(message, receivedAt)
      if (type === 'system' && subtype === 'api_retry') return handleApiRetry(message, receivedAt)
      if (type === 'system' && subtype === 'compact_boundary') return handleCompactBoundary(message, receivedAt)
      return null // live-edge ephemera — the on-disk transcript is the record
    },

    recordSend(uuid, text, at) {
      pendingSends.add(uuid)
      const record = { uuid, timestamp: at, message: { role: 'user', content: text } }
      const { appended, patched } = deriver.push([record])
      const { appended: outAppended, patched: outPatched } = ingestDerived(appended, patched)
      revision += 1
      return { revision, appended: outAppended, patched: outPatched, partial: null, pendingSends: [...pendingSends] }
    },

    window() {
      // A snapshot, never a live reference — `ring` itself keeps mutating in
      // place as later pushes/patches land, and a caller (session:attach)
      // must not see those land inside a window it already received.
      return { entries: ring.slice(), firstIndex, partial: liveBlock, pendingSends: [...pendingSends], revision }
    },
  }
}

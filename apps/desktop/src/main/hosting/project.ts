// A pure projector turning the live SDK message stream into the same TranscriptEntry shape
// already derived from a session's on-disk .jsonl. Never throws: an unrecognized message is skipped.
import type { EntryPatch, MetaEntry, TranscriptEntry } from '../../shared/sessions/transcript'
import { MAX_PAYLOAD_CHARS } from '../../shared/sessions/transcript'
import { isRecord } from '../../shared/guards'
import { createDeriver, sanitize } from '../sessions/transcript-entries'
import type { LiveBlock, LiveBlockKind, PartialUpdate, SessionEntriesDelta } from '../../shared/hosting/types'
import type { ContentBlock } from './content'

export interface CreateSessionProjectorParams {
  /** Used only to shorten a headline path, never to resolve or open anything. */
  readonly cwd: string
}

/** The bounded ring's size — a live session's window, never a growing per-session array. */
export const ENTRY_RETAIN_LIMIT = 500

/** Everything `SessionEntriesDelta` carries except `sessionKey`, which only `handle.ts` adds. */
export type ProjectedDelta = Omit<SessionEntriesDelta, 'sessionKey'>

export interface SessionProjectorWindow {
  readonly entries: readonly TranscriptEntry[]
  /** The absolute index of `entries[0]`; `0` until the ring has dropped its oldest rows. */
  readonly firstIndex: number
  readonly partial: LiveBlock | null
  readonly pendingSends: readonly string[]
  readonly revision: number
}

export interface SessionProjector {
  /** `null` when the message produced no visible change. Never throws: an unrecognized message is skipped. */
  push(message: unknown, receivedAt: string): ProjectedDelta | null
  /** Marks the uuid pending until an ack frame or a `result` arrives; `content` is a plain string with no attachments. */
  recordSend(uuid: string, content: string | ContentBlock[], at: string): ProjectedDelta
  /** The current bounded state — what `session:attach` hands a reconnecting renderer. */
  window(): SessionProjectorWindow
}

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

  // Deriver-produced entries and directly-built meta rows share one absolute-index sequence.
  let ring: TranscriptEntry[] = []
  let firstIndex = 0
  let nextAbsoluteIndex = 0

  // Mirrors the deriver's own running index, resolving a patch's deriver-space index to this
  // projector's absolute space. Held only while a tool call is still open.
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
    // Evicted from the ring already; the patch still crosses the boundary but has nothing to overwrite here.
    if (relative < 0 || relative >= ring.length) return
    ring[relative] = entry
  }

  /** Folds one deriver `push` result into the window, translating each patch's index through `openToolCalls`. */
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

    // Fallback: an empty or absent queue means every send this turn consumed is done.
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

    recordSend(uuid, content, at) {
      pendingSends.add(uuid)
      const record = { uuid, timestamp: at, message: { role: 'user', content } }
      const { appended, patched } = deriver.push([record])
      const { appended: outAppended, patched: outPatched } = ingestDerived(appended, patched)
      revision += 1
      return { revision, appended: outAppended, patched: outPatched, partial: null, pendingSends: [...pendingSends] }
    },

    window() {
      // A snapshot, never a live reference — `ring` keeps mutating in place as later pushes land.
      return { entries: ring.slice(), firstIndex, partial: liveBlock, pendingSends: [...pendingSends], revision }
    },
  }
}

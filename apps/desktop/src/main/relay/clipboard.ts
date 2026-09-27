// The one electron clipboard write for the relay loop (#107), behind an
// injectable seam — the IPC edge validates before electron is ever touched,
// so a malformed or oversized payload never reaches it, the same "the main
// side validates, never trusts the renderer" rule `main/relay/read.ts`'s own
// caller (`main/ipc.ts`) restates for this channel.
import { clipboard } from 'electron'
import { MAX_PAYLOAD_CHARS } from '../../shared/sessions/transcript'
import type { RelayCopyResponse } from '../../shared/relay/types'

export interface CopyRelayReplyParams {
  readonly text: unknown
}

export type CopyRelayReplyResult = RelayCopyResponse

/** `MAX_REPLY_CHARS` matches `MAX_PAYLOAD_CHARS` — the same cap a single
 *  rendered transcript payload already carries, reused rather than a second
 *  hand-picked number. */
export const MAX_REPLY_CHARS = MAX_PAYLOAD_CHARS

export function copyRelayReply(params: CopyRelayReplyParams, writer: (text: string) => void = (text) => clipboard.writeText(text)): CopyRelayReplyResult {
  const { text } = params
  if (typeof text !== 'string' || text === '' || text.length > MAX_REPLY_CHARS) return { ok: false }
  writer(text)
  return { ok: true }
}

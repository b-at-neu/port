// Pure link resolution from dispatch records to a board item's stage sessions — renderer-safe, no I/O.
import type { DispatchRecord } from '@/types/dispatch'
import type { PipelineItemKind } from '@/types/github'
import type { SessionKey } from '@/types/hosting'
import type { StageAgent } from '@/types/tick'

export type StageLink =
  | { readonly kind: 'live'; readonly agent: StageAgent; readonly sessionKey: SessionKey; readonly at: string; readonly operatorJoined: boolean }
  | { readonly kind: 'transcript'; readonly agent: StageAgent; readonly sessionId: string; readonly at: string; readonly operatorJoined: boolean }

function matches(record: DispatchRecord, number: number, kind: PipelineItemKind): boolean {
  return record.number === number && record.kind === kind
}

/** Newest first. `failed`, or `ended` without a `claudeSessionId` (it died before `init`), are skipped. At most one `live` link: among several `started` records for the same item, only the newest is live — the older resolves as if ended. */
export function stageLinksFor(records: readonly DispatchRecord[], number: number, kind: PipelineItemKind): readonly StageLink[] {
  const matching = records.filter((r) => matches(r, number, kind))
  const started = matching.filter((r) => r.state === 'started').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const newestLive = started[0]

  const links: StageLink[] = []
  for (const record of matching) {
    if (record.state === 'failed') continue
    if (record.state === 'started') {
      if (record === newestLive && record.sessionKey !== null) {
        links.push({ kind: 'live', agent: record.agent, sessionKey: record.sessionKey, at: record.at, operatorJoined: record.operatorJoinedAt !== null })
      } else if (record.claudeSessionId !== null) {
        links.push({ kind: 'transcript', agent: record.agent, sessionId: record.claudeSessionId, at: record.at, operatorJoined: record.operatorJoinedAt !== null })
      }
      continue
    }
    // state === 'ended'
    if (record.claudeSessionId !== null) {
      links.push({ kind: 'transcript', agent: record.agent, sessionId: record.claudeSessionId, at: record.at, operatorJoined: record.operatorJoinedAt !== null })
    }
  }

  return links.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** `true` when any matching record carries an operator join. */
export function operatorJoinedOf(records: readonly DispatchRecord[], number: number, kind: PipelineItemKind): boolean {
  return records.filter((r) => matches(r, number, kind)).some((r) => r.operatorJoinedAt !== null)
}

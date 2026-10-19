// Pure link resolution from dispatch records to a board item's stage sessions — renderer-safe, no I/O.
import type { DispatchRecord } from '@/types/dispatch'
import type { StageLink, StageLinkTarget } from '@/types/board'

function matches(record: DispatchRecord, target: StageLinkTarget): boolean {
  return record.number === target.number && record.kind === target.kind
}

function matchesAny(record: DispatchRecord, targets: readonly StageLinkTarget[]): boolean {
  return targets.some((target) => matches(record, target))
}

/** Newest first. `failed`, or `ended` without a `claudeSessionId` (it died before `init`), are skipped. At most one `live` link per target: among several `started` records for the same target, only the newest is live — the older resolves as if ended. */
export function stageLinksFor(records: readonly DispatchRecord[], targets: readonly StageLinkTarget[]): readonly StageLink[] {
  const matching = records.filter((r) => matchesAny(r, targets))
  const newestLive = new Set<DispatchRecord>()
  for (const target of targets) {
    const started = matching.filter((r) => matches(r, target) && r.state === 'started').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    const newest = started[0]
    if (newest !== undefined) newestLive.add(newest)
  }

  const links: StageLink[] = []
  for (const record of matching) {
    if (record.state === 'failed') continue
    if (record.state === 'started') {
      if (newestLive.has(record) && record.sessionKey !== null) {
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
export function operatorJoinedOf(records: readonly DispatchRecord[], targets: readonly StageLinkTarget[]): boolean {
  return records.filter((r) => matchesAny(r, targets)).some((r) => r.operatorJoinedAt !== null)
}

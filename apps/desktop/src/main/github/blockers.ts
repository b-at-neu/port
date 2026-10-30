import type { BlockerRead, ClaimBlocker } from '@/types/github'

/** Reads a `blockedBy` connection into a `BlockerRead`. An unreadable connection is reported by
 *  name rather than folded into an empty list. `shown`/`total` count every node, open or closed. */
export function toBlockerRead(value: unknown, errored: boolean): BlockerRead {
  if (errored) return { ok: false, reason: "GitHub reported an error reading this issue's blockers" }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'blockedBy is missing from the response' }
  const connection = value as { totalCount?: unknown; nodes?: unknown }
  if (typeof connection.totalCount !== 'number' || !Array.isArray(connection.nodes)) {
    return { ok: false, reason: 'blockedBy is malformed' }
  }
  const open: ClaimBlocker[] = []
  for (const node of connection.nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    const state = typeof raw.state === 'string' ? raw.state : ''
    if (state !== 'OPEN') continue
    open.push({
      number: typeof raw.number === 'number' ? raw.number : 0,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      state,
    })
  }
  return { ok: true, open, shown: connection.nodes.length, total: connection.totalCount }
}

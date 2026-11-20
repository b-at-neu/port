import type { BlockerRead, ClaimBlocker } from '@/types/github'
import type { ChildBlockerRead } from '@/types/backlog'

type ConnectionRead =
  | { readonly ok: true; readonly nodes: readonly ClaimBlocker[]; readonly shown: number; readonly total: number }
  | { readonly ok: false; readonly reason: string }

/** Parses a `blockedBy` connection into every node it carries, state included. An unreadable
 *  connection is reported by name rather than folded into an empty list. */
function readConnection(value: unknown, errored: boolean, field: 'blockedBy' | 'blocking'): ConnectionRead {
  if (errored) {
    const what = field === 'blocking' ? 'the issues this one blocks' : "this issue's blockers"
    return { ok: false, reason: `GitHub reported an error reading ${what}` }
  }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: `${field} is missing from the response` }
  const connection = value as { totalCount?: unknown; nodes?: unknown }
  if (typeof connection.totalCount !== 'number' || !Array.isArray(connection.nodes)) {
    return { ok: false, reason: `${field} is malformed` }
  }
  const nodes: ClaimBlocker[] = []
  for (const node of connection.nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    nodes.push({
      number: typeof raw.number === 'number' ? raw.number : 0,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      state: typeof raw.state === 'string' ? raw.state : '',
    })
  }
  return { ok: true, nodes, shown: connection.nodes.length, total: connection.totalCount }
}

/** Reads a `blockedBy` connection into a `BlockerRead` holding the `OPEN` nodes only.
 *  `shown`/`total` count every node, open or closed. */
export function toBlockerRead(value: unknown, errored: boolean, field: 'blockedBy' | 'blocking' = 'blockedBy'): BlockerRead {
  const read = readConnection(value, errored, field)
  if (!read.ok) return read
  return { ok: true, open: read.nodes.filter((node) => node.state === 'OPEN'), shown: read.shown, total: read.total }
}

/** Like `toBlockerRead`, but keeps the `CLOSED` nodes too, so a layering over the whole child graph sees closed edges. */
export function toChildBlockerRead(value: unknown, errored: boolean): ChildBlockerRead {
  const read = readConnection(value, errored, 'blockedBy')
  if (!read.ok) return read
  return {
    ok: true,
    open: read.nodes.filter((node) => node.state === 'OPEN'),
    closed: read.nodes.filter((node) => node.state === 'CLOSED'),
    shown: read.shown,
    total: read.total,
  }
}

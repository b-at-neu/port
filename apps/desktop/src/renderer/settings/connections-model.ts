// Pure connection overview — one line per connection, shared by the Connections tab and the
// status popover. A check that could not run is never shown as healthy.
import type { QueryObserverResult } from '@tanstack/react-query'
import type { BoardSnapshot } from '@/types/board'
import { RATE_LIMIT_FLOOR } from '@/types/board'
import type { GhStatus } from '@/types/gh'
import type { RuntimePreflight } from '@/types/runtime'
import { formatAgo } from '@/renderer/lib/relative-time'

type ConnectionTone = 'success' | 'attention' | 'danger' | 'idle'

export interface ConnectionLine {
  readonly key: string
  readonly label: string
  readonly state: string
  /** `checked 2m ago`; `null` when the state already carries its own age. */
  readonly age: string | null
  readonly tone: ConnectionTone
}

type QueryLike<T> = Pick<QueryObserverResult<T>, 'status' | 'data'>

interface ConnectionOverviewParams {
  readonly preflight: QueryLike<RuntimePreflight>
  readonly gh: QueryLike<GhStatus>
  readonly snapshot: BoardSnapshot | undefined
  readonly displayNames: Readonly<Record<string, string>>
  readonly now: Date
}

function checkedAgo(checkedAt: string, now: Date): string {
  return `checked ${formatAgo(now.getTime() - Date.parse(checkedAt))}`
}

function claudeLine(query: QueryLike<RuntimePreflight>, now: Date): ConnectionLine {
  const key = 'claude'
  const label = 'Claude Code'
  if (query.status === 'pending') return { key, label, state: 'checking…', age: null, tone: 'idle' }
  if (query.status === 'error' || query.data === undefined) return { key, label, state: "couldn't check", age: null, tone: 'idle' }
  const { diagnosis, checkedAt } = query.data
  const age = checkedAgo(checkedAt, now)
  if (diagnosis === 'unverified' || diagnosis === 'verified') return { key, label, state: 'ready', age, tone: 'success' }
  if (diagnosis === 'cli-missing' || diagnosis === 'bundled-fallback') return { key, label, state: 'not installed', age, tone: 'danger' }
  return { key, label, state: 'not ready', age, tone: 'danger' }
}

function ghLine(query: QueryLike<GhStatus>, now: Date): ConnectionLine {
  const key = 'gh'
  const label = 'gh'
  if (query.status === 'pending') return { key, label, state: 'checking…', age: null, tone: 'idle' }
  if (query.status === 'error' || query.data === undefined) return { key, label, state: "couldn't check", age: null, tone: 'idle' }
  const status = query.data
  const age = checkedAgo(status.checkedAt, now)
  switch (status.kind) {
    case 'signed-in':
      return { key, label, state: status.account !== null ? `signed in as ${status.account}` : 'signed in', age, tone: 'success' }
    case 'signed-out':
      return { key, label, state: 'signed out', age, tone: 'danger' }
    case 'missing':
      return { key, label, state: 'not installed', age, tone: 'danger' }
    case 'unknown':
      return { key, label, state: "couldn't check", age, tone: 'idle' }
  }
}

function clockTime(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours())}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The rate limit of the repository whose GitHub read succeeded last — every repository shares one gh token, so one number is honest. */
function rateLimitLine(snapshot: BoardSnapshot | undefined): ConnectionLine {
  const key = 'github'
  const label = 'GitHub'
  if (snapshot === undefined) return { key, label, state: 'checking…', age: null, tone: 'idle' }
  let newest: { readonly at: number; readonly remaining: number; readonly limit: number; readonly resetAt: string } | null = null
  for (const repository of snapshot.state.repositories) {
    if (!repository.ok) continue
    const read = snapshot.health.find((h) => h.repoId === repository.repoId)?.github.lastSuccessAt ?? null
    const { remaining, limit, resetAt } = repository.rateLimit
    if (read === null || (remaining === 0 && limit === 0)) continue
    const at = Date.parse(read)
    if (newest === null || at > newest.at) newest = { at, remaining, limit, resetAt }
  }
  if (newest === null) return { key, label, state: 'no read yet', age: null, tone: 'idle' }
  const points = `${newest.remaining.toLocaleString('en-US')} points left`
  if (newest.remaining < RATE_LIMIT_FLOOR) return { key, label, state: `${points} · resets ${clockTime(newest.resetAt)}`, age: null, tone: 'attention' }
  return { key, label, state: points, age: null, tone: 'success' }
}

function repositoryLines(snapshot: BoardSnapshot | undefined, displayNames: Readonly<Record<string, string>>, now: Date): readonly ConnectionLine[] {
  if (snapshot === undefined) return []
  return snapshot.health.map((health) => {
    const label = displayNames[health.repoId] ?? health.repoId
    const { lastSuccessAt, consecutiveFailures } = health.github
    const ago = lastSuccessAt !== null ? formatAgo(now.getTime() - Date.parse(lastSuccessAt)) : null
    if (consecutiveFailures > 0) {
      return { key: `repo:${health.repoId}`, label, state: ago !== null ? `last read ${ago} · failing` : 'never read · failing', age: null, tone: 'attention' as const }
    }
    if (ago === null) return { key: `repo:${health.repoId}`, label, state: 'never read', age: null, tone: 'idle' as const }
    return { key: `repo:${health.repoId}`, label, state: `read ${ago}`, age: null, tone: 'success' as const }
  })
}

export function connectionOverview(params: ConnectionOverviewParams): readonly ConnectionLine[] {
  const { preflight, gh, snapshot, displayNames, now } = params
  return [claudeLine(preflight, now), ghLine(gh, now), rateLimitLine(snapshot), ...repositoryLines(snapshot, displayNames, now)]
}

/** `Claude Code · ready · checked 2m ago` — the popover's and the tab's one line shape. */
export function connectionText(line: ConnectionLine): string {
  return [line.label, line.state, line.age].filter((part): part is string => part !== null).join(' · ')
}

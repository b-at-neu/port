// Every route id `router.tsx` registers, plus the search-param parsers each
// route needs — the one literal spelling both files read, so they never drift.
import type { RepoId } from '../../../shared/repos'

export const ROUTE_IDS = {
  board: '/board',
  backlog: '/backlog',
  needsYou: '/needs-you',
  repos: '/repositories',
  repo: '/repositories/$repoId',
  history: '/history',
  search: '/search',
  transcript: '/transcript/$sessionId',
  session: '/session',
  settings: '/settings',
  setup: '/setup',
  about: '/about',
} as const

/** Every route a launch or `shell/prefs.ts`'s `trackLastRoute` may restore
 *  onto — screens whose state survives a quit/relaunch. */
export const RESTORABLE_ROUTES: readonly string[] = [ROUTE_IDS.board, ROUTE_IDS.repos, ROUTE_IDS.session, ROUTE_IDS.settings, ROUTE_IDS.backlog, ROUTE_IDS.needsYou, ROUTE_IDS.history]

export interface BoardItemRef {
  readonly repoId: RepoId
  readonly number: number
}

/** Every field optional at the type level — `navigate({ to: ROUTE_IDS.board })`
 *  with no `search` still type-checks. */
export interface BoardSearch {
  readonly item?: BoardItemRef | null
  readonly group?: 'phase' | 'repo'
  readonly repo?: RepoId | null
}

const BOARD_ITEM_RE = /^(.+):(\d+)$/

/** `item` is the `<repoId>:<number>` URL string on a fresh parse, or an already-typed
 *  `BoardItemRef` when `validateSearch` re-runs on an in-app `navigate()`'s own result. */
function parseBoardItemRef(item: unknown): BoardItemRef | null {
  if (typeof item === 'string') {
    const match = BOARD_ITEM_RE.exec(item)
    return match !== null && match[1] !== undefined && match[2] !== undefined ? { repoId: match[1] as RepoId, number: Number(match[2]) } : null
  }
  if (item !== null && typeof item === 'object' && 'repoId' in item && 'number' in item) {
    const { repoId, number } = item as Record<string, unknown>
    if (typeof repoId === 'string' && typeof number === 'number') return { repoId: repoId as RepoId, number }
  }
  return null
}

/** `item=<repoId>:<number>` keeps the Board's selection in the URL. */
export function boardSearchFromRaw(search: Readonly<Record<string, unknown>>): BoardSearch {
  const { item, group, repo } = search
  return {
    item: parseBoardItemRef(item),
    group: group === 'repo' ? 'repo' : 'phase',
    repo: typeof repo === 'string' && repo !== '' ? (repo as RepoId) : null,
  }
}

export type RepoTab = 'overview' | 'worktrees' | 'denials'
export type DenialsGroup = 'command' | 'actor'

export interface RepoSearch {
  readonly tab?: RepoTab
  /** The Denials tab's own tabs-in-tab, persisted so a reload keeps the chosen grouping. Irrelevant outside `tab=denials`, but harmless to carry. Named distinctly from `BoardSearch.group` — TanStack Router's search params are typed across the whole route tree, so two routes sharing a key must share its type. */
  readonly denialsGroup?: DenialsGroup
}

export function repoSearchFromRaw(search: Readonly<Record<string, unknown>>): RepoSearch {
  const { tab, denialsGroup } = search
  return { tab: tab === 'worktrees' || tab === 'denials' ? tab : 'overview', denialsGroup: denialsGroup === 'actor' ? 'actor' : 'command' }
}

export interface HistorySearch {
  readonly repo?: RepoId | null
}

/** `repo` scopes History to one repository; absent or invalid means every
 *  repository — the screen's own "All repositories" default. */
export function historySearchFromRaw(search: Readonly<Record<string, unknown>>): HistorySearch {
  const { repo } = search
  return { repo: typeof repo === 'string' && repo !== '' ? (repo as RepoId) : null }
}

export interface SearchSearch {
  readonly repo?: RepoId | null
}

export function searchSearchFromRaw(search: Readonly<Record<string, unknown>>): SearchSearch {
  const { repo } = search
  return { repo: typeof repo === 'string' && repo !== '' ? (repo as RepoId) : null }
}

export interface SessionSearch {
  readonly key?: string | null
  /** `pane=changes` opens the Changes pane; anything else reads as closed. */
  readonly pane?: 'changes' | null
}

export function sessionSearchFromRaw(search: Readonly<Record<string, unknown>>): SessionSearch {
  const { key, pane } = search
  return { key: typeof key === 'string' && key !== '' ? key : null, pane: pane === 'changes' ? 'changes' : null }
}

export interface TranscriptSearch {
  readonly agentId: string | null
  readonly from: 'history' | 'search'
  readonly focusIndex: number | null
  readonly title: string
}

/** A malformed `focusIndex` becomes `null`; a malformed `from` becomes `'history'`. */
export function transcriptSearchFromRaw(search: Readonly<Record<string, unknown>>): TranscriptSearch {
  const { agentId, from, focusIndex, title } = search
  return {
    agentId: typeof agentId === 'string' ? agentId : null,
    from: from === 'search' ? 'search' : 'history',
    focusIndex: typeof focusIndex === 'number' && Number.isFinite(focusIndex) ? focusIndex : null,
    title: typeof title === 'string' ? title : '',
  }
}

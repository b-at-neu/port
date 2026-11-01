// Every route id `router.tsx` registers, plus the search-param parsers each
// route needs — the one literal spelling both files read, so they never drift.
import type { RepoId } from '@/utils/repos'
import type { AuditSearch, BoardItemRef, BoardSearch, HistorySearch, NeedsYouSearch, RepoSearch, SearchSearch, SessionSearch, SettingsSearch, SettingsSection, TranscriptSearch } from '@/types/router'

// `repos`, `repo` and `about` stay registered only as redirects into Settings.
export const ROUTE_IDS = {
  board: '/board',
  backlog: '/backlog',
  releases: '/releases',
  audit: '/audit',
  needsYou: '/needs-you',
  repos: '/repositories',
  repo: '/repositories/$repoId',
  history: '/history',
  search: '/search',
  transcript: '/transcript/$sessionId',
  session: '/session',
  settings: '/settings',
  settingsRepo: '/settings/repositories/$repoId',
  setup: '/setup',
  about: '/about',
} as const

/** Every route a launch or `shell/prefs.ts`'s `trackLastRoute` may restore
 *  onto — screens whose state survives a quit/relaunch. */
export const RESTORABLE_ROUTES: readonly string[] = [ROUTE_IDS.board, ROUTE_IDS.repos, ROUTE_IDS.session, ROUTE_IDS.settings, ROUTE_IDS.backlog, ROUTE_IDS.releases, ROUTE_IDS.needsYou, ROUTE_IDS.history, ROUTE_IDS.audit]

const BOARD_ITEM_RE = /^(.+):(\d+)$/

/** `item` is the `<repoId>:<number>` URL string on a fresh parse, or an already-typed
 *  `BoardItemRef` when `validateSearch` re-runs on an in-app `navigate()`'s own result. */
export function parseBoardItemRef(item: unknown): BoardItemRef | null {
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

// Exhaustive over `SettingsSection` by type, since this file takes no runtime import of `@/types`.
const SECTION_IDS: Readonly<Record<SettingsSection, true>> = { general: true, repositories: true, connections: true, pipeline: true, usage: true, about: true }

/** An unknown or missing `section` reads as `'general'`. */
export function settingsSearchFromRaw(search: Readonly<Record<string, unknown>>): SettingsSearch {
  const { section } = search
  return { section: typeof section === 'string' && Object.hasOwn(SECTION_IDS, section) ? (section as SettingsSection) : 'general' }
}

export function repoSearchFromRaw(search: Readonly<Record<string, unknown>>): RepoSearch {
  const { tab, denialsGroup } = search
  return { tab: tab === 'worktrees' || tab === 'denials' ? tab : 'overview', denialsGroup: denialsGroup === 'actor' ? 'actor' : 'command' }
}

/** `repo` scopes History to one repository; absent or invalid means every
 *  repository — the screen's own "All repositories" default. */
export function historySearchFromRaw(search: Readonly<Record<string, unknown>>): HistorySearch {
  const { repo, archived } = search
  return { repo: typeof repo === 'string' && repo !== '' ? (repo as RepoId) : null, archived: archived === true }
}

/** `number` survives only as a positive safe integer next to a `repo`; anything else reads as no ticket filter. */
export function auditSearchFromRaw(search: Readonly<Record<string, unknown>>): AuditSearch {
  const { repo, number } = search
  const repoId = typeof repo === 'string' && repo !== '' ? (repo as RepoId) : null
  return { repo: repoId, number: repoId !== null && typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null }
}

/** `focus` is a non-empty string, else `null`. */
export function needsYouSearchFromRaw(search: Readonly<Record<string, unknown>>): NeedsYouSearch {
  const { focus } = search
  return { focus: typeof focus === 'string' && focus !== '' ? focus : null }
}

export function searchSearchFromRaw(search: Readonly<Record<string, unknown>>): SearchSearch {
  const { repo } = search
  return { repo: typeof repo === 'string' && repo !== '' ? (repo as RepoId) : null }
}

export function sessionSearchFromRaw(search: Readonly<Record<string, unknown>>): SessionSearch {
  const { key, pane } = search
  return { key: typeof key === 'string' && key !== '' ? key : null, pane: pane === 'changes' ? 'changes' : null }
}

/** A malformed `focusIndex` becomes `null`; a malformed `from` becomes `'history'`. */
export function transcriptSearchFromRaw(search: Readonly<Record<string, unknown>>): TranscriptSearch {
  const { agentId, from, focusIndex, title, item } = search
  return {
    agentId: typeof agentId === 'string' ? agentId : null,
    from: from === 'search' ? 'search' : from === 'board' ? 'board' : from === 'pipeline' ? 'pipeline' : 'history',
    focusIndex: typeof focusIndex === 'number' && Number.isFinite(focusIndex) ? focusIndex : null,
    title: typeof title === 'string' ? title : '',
    item: parseBoardItemRef(item),
  }
}

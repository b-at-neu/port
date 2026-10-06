// The legacy `View` union (#316) — moved out of `main.ts` so the router can
// own navigation while `main.ts` stays the legacy screens' own renderer.
// `viewFromMatch`/`routeForView` are pure and router-typing-free (no import
// from `router.tsx`), so `legacy-view.test.ts` exercises them with plain
// strings instead of a real `Router` instance.
import type { RepoId } from '../../../shared/repos'

/** Which screen is on top. `board` and `repos` are the nav bar's two
 *  legacy tabs; `sessions` and `transcript` are the picker and viewer,
 *  reached only from a ready repository card; `session` is #219's hosted
 *  session tab; `settings` is the first React screen (#316). `repoLabel` is
 *  never part of the route — `repoLabelFor` re-derives it at draw time, so
 *  a route never goes stale against a repository that was renamed or
 *  removed after the route was entered. */
export type View =
  | { readonly screen: 'board' }
  | { readonly screen: 'repos' }
  | { readonly screen: 'sessions'; readonly repoId: RepoId }
  | { readonly screen: 'search'; readonly repoId: RepoId }
  /** `from` is where `‹ Back` returns to -- the sessions picker normally,
   *  the search screen (already in memory, no requery) when a hit opened
   *  this transcript. */
  | { readonly screen: 'transcript'; readonly sessionId: string; readonly agentId: string | null; readonly title: string; readonly from: 'sessions' | 'search'; readonly focusIndex: number | null }
  | { readonly screen: 'session' }
  | { readonly screen: 'settings' }
  | { readonly screen: 'backlog' }
  | { readonly screen: 'needsYou' }
  | { readonly screen: 'setup' }
  | { readonly screen: 'about' }

/** Which legacy container a screen draws into — `main.ts`'s `drawViews`
 *  shows exactly one of the four and hides the rest. `backlog`, `settings`,
 *  `setup` and `about` all map to `react`, since every one is a React screen
 *  mounted into the same portaled `#react-root` (#316, replacing `Tab`). */
export type LegacyContainer = 'board' | 'repositories' | 'session' | 'react'

/** True for every route mounted into `#react-root`. */
export function isReactScreen(view: View): boolean {
  return view.screen === 'settings' || view.screen === 'backlog' || view.screen === 'setup' || view.screen === 'about' || view.screen === 'needsYou'
}

export function containerFor(view: View): LegacyContainer {
  if (view.screen === 'board') return 'board'
  if (view.screen === 'session') return 'session'
  if (isReactScreen(view)) return 'react'
  return 'repositories'
}

/** Every route id `router/router.tsx` registers — the one literal spelling
 *  both that file and this one read, so the two can never drift. */
export const ROUTE_IDS = {
  board: '/board',
  backlog: '/backlog',
  needsYou: '/needs-you',
  repos: '/repositories',
  sessions: '/repositories/$repoId/sessions',
  search: '/repositories/$repoId/search',
  transcript: '/transcript/$sessionId',
  session: '/session',
  settings: '/settings',
  setup: '/setup',
  about: '/about',
} as const

/** Every route a launch or `shell/prefs.ts`'s `trackLastRoute` may restore
 *  onto — screens whose state survives a quit/relaunch. */
export const RESTORABLE_ROUTES: readonly string[] = [ROUTE_IDS.board, ROUTE_IDS.repos, ROUTE_IDS.session, ROUTE_IDS.settings, ROUTE_IDS.backlog, ROUTE_IDS.needsYou]

export interface TranscriptSearch {
  readonly agentId: string | null
  readonly from: 'sessions' | 'search'
  readonly focusIndex: number | null
  readonly title: string
}

/** Invalid search params fail toward the safest reading rather than
 *  throwing — a malformed `focusIndex` becomes `null` (no scroll target),
 *  a malformed `from` becomes `'sessions'` (the picker, always reachable). */
export function transcriptSearchFromRaw(search: Readonly<Record<string, unknown>>): TranscriptSearch {
  const { agentId, from, focusIndex, title } = search
  return {
    agentId: typeof agentId === 'string' ? agentId : null,
    from: from === 'search' ? 'search' : 'sessions',
    focusIndex: typeof focusIndex === 'number' && Number.isFinite(focusIndex) ? focusIndex : null,
    title: typeof title === 'string' ? title : '',
  }
}

/** The router's own match (routeId, params, search) turned back into a
 *  `View` — the inverse of `routeForView`. An unrecognized routeId reads as
 *  `board`, the router's own `/` and wildcard redirect target, so this is
 *  never called against a match that `router.tsx` would not itself resolve
 *  there first. */
export function viewFromMatch(routeId: string, params: Readonly<Record<string, string | undefined>>, search: Readonly<Record<string, unknown>>): View {
  switch (routeId) {
    case ROUTE_IDS.board:
      return { screen: 'board' }
    case ROUTE_IDS.repos:
      return { screen: 'repos' }
    case ROUTE_IDS.sessions:
      return { screen: 'sessions', repoId: (params.repoId ?? '') as RepoId }
    case ROUTE_IDS.search:
      return { screen: 'search', repoId: (params.repoId ?? '') as RepoId }
    case ROUTE_IDS.transcript: {
      const { agentId, from, focusIndex, title } = transcriptSearchFromRaw(search)
      return { screen: 'transcript', sessionId: params.sessionId ?? '', agentId, title, from, focusIndex }
    }
    case ROUTE_IDS.session:
      return { screen: 'session' }
    case ROUTE_IDS.settings:
      return { screen: 'settings' }
    case ROUTE_IDS.backlog:
      return { screen: 'backlog' }
    case ROUTE_IDS.needsYou:
      return { screen: 'needsYou' }
    case ROUTE_IDS.setup:
      return { screen: 'setup' }
    case ROUTE_IDS.about:
      return { screen: 'about' }
    default:
      return { screen: 'board' }
  }
}

export interface RouteDescriptor {
  readonly to: string
  readonly params?: Readonly<Record<string, string>>
  readonly search?: Readonly<Record<string, unknown>>
}

/** The inverse of `viewFromMatch` — what `router.navigate(…)` needs to land
 *  on this exact `View`. Deliberately untyped against the router's own
 *  `Register`, so this file stays importable from a plain `vitest` test with
 *  no router instance in scope; `main.ts` is the one seam that asserts the
 *  result against the real navigate signature. */
export function routeForView(view: View): RouteDescriptor {
  switch (view.screen) {
    case 'board':
      return { to: ROUTE_IDS.board }
    case 'repos':
      return { to: ROUTE_IDS.repos }
    case 'sessions':
      return { to: ROUTE_IDS.sessions, params: { repoId: view.repoId } }
    case 'search':
      return { to: ROUTE_IDS.search, params: { repoId: view.repoId } }
    case 'transcript':
      return {
        to: ROUTE_IDS.transcript,
        params: { sessionId: view.sessionId },
        search: { agentId: view.agentId, from: view.from, focusIndex: view.focusIndex, title: view.title },
      }
    case 'session':
      return { to: ROUTE_IDS.session }
    case 'settings':
      return { to: ROUTE_IDS.settings }
    case 'backlog':
      return { to: ROUTE_IDS.backlog }
    case 'needsYou':
      return { to: ROUTE_IDS.needsYou }
    case 'setup':
      return { to: ROUTE_IDS.setup }
    case 'about':
      return { to: ROUTE_IDS.about }
  }
}

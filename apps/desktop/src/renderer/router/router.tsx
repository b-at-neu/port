// The app's one router — code-based, hash history (`loadFile` serves
// `file://`, where path history cannot resolve).
import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { ROUTE_IDS, boardSearchFromRaw, historySearchFromRaw, repoSearchFromRaw, searchSearchFromRaw, sessionSearchFromRaw, transcriptSearchFromRaw } from './routes'
import type { BoardSearch, HistorySearch, RepoSearch, SearchSearch, SessionSearch, TranscriptSearch } from './routes'
import { SettingsScreen } from '../settings/screen'
import { BacklogScreen } from '../backlog/screen'
import { NeedsYouScreen } from '../needs-you/screen'
import { SetupScreen } from '../setup/screen'
import { AboutScreen } from '../about/screen'
import { BoardScreen } from '../board/screen'
import { RepositoriesScreen } from '../repositories/screen'
import { RepoScreen } from '../repositories/repo-screen'
import { SessionScreen } from '../session/screen'
import { HistoryScreen } from '../history/screen'
import { TranscriptScreen } from '../transcript/screen'
import { SearchScreen } from '../search/screen'
import { ShellLayout } from '../shell/layout'

const rootRoute = createRootRoute({ component: ShellLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: ROUTE_IDS.board })
  },
})

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.board,
  component: BoardScreen,
  validateSearch: (search: Record<string, unknown>): BoardSearch => boardSearchFromRaw(search),
})
const reposRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.repos, component: RepositoriesScreen })
const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.repo,
  component: RepoScreen,
  validateSearch: (search: Record<string, unknown>): RepoSearch => repoSearchFromRaw(search),
})

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.history,
  component: HistoryScreen,
  validateSearch: (search: Record<string, unknown>): HistorySearch => historySearchFromRaw(search),
})
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.search,
  component: SearchScreen,
  validateSearch: (search: Record<string, unknown>): SearchSearch => searchSearchFromRaw(search),
})

const transcriptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.transcript,
  component: TranscriptScreen,
  validateSearch: (search: Record<string, unknown>): TranscriptSearch => transcriptSearchFromRaw(search),
})

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.session,
  component: SessionScreen,
  validateSearch: (search: Record<string, unknown>): SessionSearch => sessionSearchFromRaw(search),
})
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.settings, component: SettingsScreen })
const backlogRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.backlog, component: BacklogScreen })
const needsYouRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.needsYou, component: NeedsYouScreen })
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.setup, component: SetupScreen })
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.about, component: AboutScreen })

// Any unknown path redirects to /board (ticket's own route table) — a
// bare `*` route is TanStack Router's own catch-all.
const catchAllRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '*',
  beforeLoad: () => {
    throw redirect({ to: ROUTE_IDS.board })
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  reposRoute,
  repoRoute,
  historyRoute,
  searchRoute,
  transcriptRoute,
  sessionRoute,
  settingsRoute,
  backlogRoute,
  needsYouRoute,
  setupRoute,
  aboutRoute,
  catchAllRoute,
])

export const router = createRouter({ routeTree, history: createHashHistory() })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

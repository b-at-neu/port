// The app's one router — code-based, hash history (`loadFile` serves
// `file://`, where path history cannot resolve).
import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { ROUTE_IDS, boardSearchFromRaw, historySearchFromRaw, needsYouSearchFromRaw, repoSearchFromRaw, searchSearchFromRaw, sessionSearchFromRaw, settingsSearchFromRaw, transcriptSearchFromRaw } from '@/renderer/router/routes'
import type { BoardSearch, HistorySearch, NeedsYouSearch, RepoSearch, SearchSearch, SessionSearch, SettingsSearch, TranscriptSearch } from '@/types/router'
import { SettingsScreen } from '@/renderer/settings/screen'
import { BacklogScreen } from '@/renderer/backlog/screen'
import { NeedsYouScreen } from '@/renderer/needs-you/screen'
import { SetupScreen } from '@/renderer/setup/screen'
import { BoardScreen } from '@/renderer/board/screen'
import { RepoScreen } from '@/renderer/repositories/repo-screen'
import { SessionScreen } from '@/renderer/session/screen'
import { HistoryScreen } from '@/renderer/history/screen'
import { TranscriptScreen } from '@/renderer/transcript/screen'
import { SearchScreen } from '@/renderer/search/screen'
import { ShellLayout } from '@/renderer/shell/layout'

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
const reposRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.repos,
  beforeLoad: () => {
    throw redirect({ to: ROUTE_IDS.settings, search: { section: 'repositories' } })
  },
})
const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.repo,
  validateSearch: (search: Record<string, unknown>): RepoSearch => repoSearchFromRaw(search),
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: ROUTE_IDS.settingsRepo, params, search })
  },
})
const settingsRepoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.settingsRepo,
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
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.settings,
  component: SettingsScreen,
  validateSearch: (search: Record<string, unknown>): SettingsSearch => settingsSearchFromRaw(search),
})
const backlogRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.backlog, component: BacklogScreen })
const needsYouRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.needsYou,
  component: NeedsYouScreen,
  validateSearch: (search: Record<string, unknown>): NeedsYouSearch => needsYouSearchFromRaw(search),
})
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.setup, component: SetupScreen })
const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.about,
  beforeLoad: () => {
    throw redirect({ to: ROUTE_IDS.settings, search: { section: 'about' } })
  },
})

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
  settingsRepoRoute,
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

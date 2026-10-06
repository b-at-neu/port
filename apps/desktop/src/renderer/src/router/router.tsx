// The router replacing `main.ts`'s hand-rolled `View` union (#316) —
// code-based, hash history (`loadFile` serves `file://`, where path history
// cannot resolve). Every legacy screen renders `null`: the legacy DOM under
// `main.ts` keeps drawing them, so the route exists only to be the one
// source of truth for which screen is on top. `/settings` is the one route
// that renders a real component — the renderer's first React screen.
import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { ROUTE_IDS, boardSearchFromRaw, transcriptSearchFromRaw } from './legacy-view'
import type { BoardSearch, TranscriptSearch } from './legacy-view'
import { SettingsScreen } from '../settings/screen'
import { BacklogScreen } from '../backlog/screen'
import { NeedsYouScreen } from '../needs-you/screen'
import { SetupScreen } from '../setup/screen'
import { AboutScreen } from '../about/screen'
import { BoardScreen } from '../board/screen'
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
const reposRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.repos, component: () => null })
const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.sessions, component: () => null })
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.search, component: () => null })

const transcriptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_IDS.transcript,
  component: () => null,
  validateSearch: (search: Record<string, unknown>): TranscriptSearch => transcriptSearchFromRaw(search),
})

const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: ROUTE_IDS.session, component: () => null })
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
  sessionsRoute,
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

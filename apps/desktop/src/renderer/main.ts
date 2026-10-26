import '@/renderer/styles/app.css'
import { router } from '@/renderer/router/router'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { createQueryClient, ipcQueryOptions } from '@/renderer/data/query'
import { connectQueryCache } from '@/renderer/data/subscriptions'
import { connectItemActionPruning } from '@/renderer/board/screen'
import { connectNeedsYouNotifications } from '@/renderer/needs-you/notify'
import { mountReact } from '@/renderer/react/mount'
import { themeStore } from '@/renderer/theme/store'
import { trackLastRoute } from '@/renderer/shell/prefs'
import { initSidebarCollapsed, listNavigatorFor, openNewSessionDialog, openPalette, setRenaming, toggleSidebarCollapsed } from '@/renderer/shell/stores'
import { shellPrefs, setSidebarCollapsed } from '@/renderer/shell/prefs'
import { installKeyboardMap, runAppCommand } from '@/renderer/shell/keyboard'
import type { KeyboardDeps } from '@/types/shell'
import { liveSessionKeys, selectSession, setSessionsQueryClient } from '@/renderer/session/actions'
import { selectedSession } from '@/renderer/session/selection'
import { shouldRedirectToSetup } from '@/renderer/setup/launch-redirect'
import { sharedSubscriptions } from '@/renderer/data/subscriptions'

const app = document.querySelector<HTMLDivElement>('#app')

function currentListScreen(): 'board' | 'backlog' | 'needsYou' | null {
  const pathname = router.state.location.pathname
  if (pathname === ROUTE_IDS.board) return 'board'
  if (pathname === ROUTE_IDS.backlog) return 'backlog'
  if (pathname === ROUTE_IDS.needsYou) return 'needsYou'
  return null
}

// Boot order: theme, query client, push-cache wiring, React mount, keyboard map.
themeStore().apply()
const queryClient = createQueryClient()
connectQueryCache(queryClient)
connectItemActionPruning(queryClient)
connectNeedsYouNotifications(queryClient)
setSessionsQueryClient(queryClient)
initSidebarCollapsed(shellPrefs().sidebarCollapsed)
if (app) mountReact(app, queryClient)

// Built once so the keymap and the app-menu/notification push run the identical action.
const actionDeps: KeyboardDeps = {
  openPalette,
  openNewSessionDialog,
  liveSessionKeys,
  currentSessionKey: () => selectedSession(),
  selectSession,
  openNeedsYou: (focus) => void router.navigate({ to: ROUTE_IDS.needsYou, search: { focus } }),
  toggleSidebar: () => setSidebarCollapsed(toggleSidebarCollapsed()),
  startRename: () => {
    const key = selectedSession()
    if (key === null) return
    if (shellPrefs().sidebarCollapsed) setSidebarCollapsed(toggleSidebarCollapsed())
    setRenaming(key)
  },
  currentListNavigator: () => {
    const screen = currentListScreen()
    return screen !== null ? listNavigatorFor(screen) : undefined
  },
}

installKeyboardMap(actionDeps)
sharedSubscriptions().subscribe('app:command', (command) => runAppCommand(command, actionDeps))

async function boot(): Promise<void> {
  router.subscribe('onResolved', () => {
    trackLastRoute(router.state.location.pathname)
  })
  // Restores the last screen on a fresh launch; an explicit deep link wins.
  const lastRoute = shellPrefs().lastRoute
  if (lastRoute !== null && (location.hash === '' || location.hash === '#/')) router.history.replace(`#${lastRoute}`)
  await router.load()
  if (await shouldRedirectToSetup(queryClient)) await router.navigate({ to: ROUTE_IDS.setup })
  // Seeds the `repos:list` cache once; `repositories/screen.tsx`'s own query keeps it current from here on.
  void queryClient.fetchQuery(ipcQueryOptions('repos:list'))
}
void boot()

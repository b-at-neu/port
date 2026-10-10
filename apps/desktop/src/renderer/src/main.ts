import './styles/app.css'
import { router } from './router/router'
import { ROUTE_IDS } from './router/routes'
import { createQueryClient, ipcQueryOptions } from './data/query'
import { connectQueryCache } from './data/subscriptions'
import { connectItemActionPruning } from './board/screen'
import { mountReact } from './react/mount'
import { themeStore } from './theme/store'
import { trackLastRoute } from './shell/prefs'
import { initSidebarCollapsed, listNavigatorFor, openPalette, setRenaming, toggleSidebarCollapsed } from './shell/stores'
import { shellPrefs, setSidebarCollapsed } from './shell/prefs'
import { installKeyboardMap, runAppCommand } from './shell/keyboard'
import type { KeyboardDeps } from './shell/keyboard'
import { liveSessionKeys, selectSession, setSessionsQueryClient, startNewSession } from './session/actions'
import { selectedSession } from './session/selection'
import { toast } from 'sonner'
import { shouldRedirectToSetup } from './setup/launch-redirect'
import { sharedSubscriptions } from './data/subscriptions'
import type { RepositoryEntry } from '../../shared/repos'
import type { ReposListResponse } from '../../shared/ipc'

const app = document.querySelector<HTMLDivElement>('#app')

/** Reads the repository list from the query cache — the Repositories
 *  screen's own query keeps it current; `boot()` seeds it once below. */
function currentRepositories(client: ReturnType<typeof createQueryClient>): readonly RepositoryEntry[] {
  const data = client.getQueryData<ReposListResponse>(ipcQueryOptions('repos:list').queryKey)
  return data?.ok === true ? data.repositories : []
}

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
setSessionsQueryClient(queryClient)
initSidebarCollapsed(shellPrefs().sidebarCollapsed)
if (app) mountReact(app, queryClient)

// Built once so the keymap and the app-menu/notification push run the identical action.
const actionDeps: KeyboardDeps = {
  openPalette,
  readyRepoIds: () => currentRepositories(queryClient).filter((r) => 'config' in r).map((r) => r.id),
  startNewSession,
  liveSessionKeys,
  currentSessionKey: () => selectedSession(),
  selectSession,
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
  noReadyRepoToast: () => toast('Register a repository to start a session.'),
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

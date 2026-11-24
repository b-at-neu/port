import '@/renderer/styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { TooltipProvider } from '@/renderer/components/ui/tooltip'
import { router } from '@/renderer/app/router'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { createQueryClient, ipcQueryOptions } from '@/renderer/data/query'
import { connectQueryCache } from '@/renderer/data/subscriptions'
import { connectItemActionPruning } from '@/renderer/board/screen'
import { connectNeedsYouNotifications } from '@/renderer/needs-you/notify'
import { themeStore } from '@/renderer/app/theme'
import { initSidebarCollapsed, openNewSessionDialog, openPalette, setRenaming, toggleSidebarCollapsed } from '@/renderer/app/stores'
import { isRepoScreenRoute, restoreHashOf, setLastRepo, shellPrefs, setSidebarCollapsed, trackLastRoute } from '@/renderer/app/prefs'
import { installKeyboardMap, runAppCommand } from '@/renderer/app/keyboard'
import type { KeyboardDeps } from '@/types/shell'
import { liveSessionKeys, selectSession, setSessionsQueryClient } from '@/renderer/session/actions'
import { currentListNavigator } from '@/renderer/app/list-navigator'
import { sessionKeyOf } from '@/renderer/app/session-key'
import { shouldRedirectToSetup } from '@/renderer/setup/launch-redirect'
import { sharedSubscriptions } from '@/renderer/data/subscriptions'
import { checkForUpdates } from '@/renderer/update/actions'

const app = document.querySelector<HTMLDivElement>('#app')

// Boot order: theme, query client, push-cache wiring, React mount, keyboard map.
themeStore().apply()
const queryClient = createQueryClient()
connectQueryCache(queryClient)
connectItemActionPruning(queryClient)
connectNeedsYouNotifications(queryClient)
setSessionsQueryClient(queryClient)
initSidebarCollapsed(shellPrefs().sidebarCollapsed)
if (app) {
  createRoot(app).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

// Built once so the keymap and the app-menu/notification push run the identical action.
const actionDeps: KeyboardDeps = {
  openPalette,
  openNewSessionDialog,
  liveSessionKeys,
  currentSessionKey: () => sessionKeyOf(router.state.location),
  selectSession,
  openNeedsYou: (focus) => void router.navigate({ to: ROUTE_IDS.needsYou, search: { focus } }),
  toggleSidebar: () => setSidebarCollapsed(toggleSidebarCollapsed()),
  startRename: () => {
    const key = sessionKeyOf(router.state.location)
    if (key === null) return
    if (shellPrefs().sidebarCollapsed) setSidebarCollapsed(toggleSidebarCollapsed())
    setRenaming(key)
  },
  checkForUpdates: () => void checkForUpdates(queryClient),
  currentListNavigator: () => currentListNavigator() ?? undefined,
}

installKeyboardMap(actionDeps)
sharedSubscriptions().subscribe('app.command', (command) => runAppCommand(command, actionDeps))

async function boot(): Promise<void> {
  router.subscribe('onResolved', () => {
    const { pathname, search } = router.state.location
    trackLastRoute(pathname)
    const repo: unknown = (search as Record<string, unknown>).repo
    if (isRepoScreenRoute(pathname) && typeof repo === 'string' && repo !== '') setLastRepo(repo)
  })
  // Restores the last screen on a fresh launch; an explicit deep link wins.
  const restoreHash = restoreHashOf(shellPrefs())
  if (restoreHash !== null && (location.hash === '' || location.hash === '#/')) router.history.replace(restoreHash)
  await router.load()
  if (await shouldRedirectToSetup(queryClient)) await router.navigate({ to: ROUTE_IDS.setup })
  // Seeds the `repos.list` cache once; the Repositories list's own query keeps it current from here on.
  void queryClient.fetchQuery(ipcQueryOptions('repos.list'))
}
void boot()

import './styles/app.css'
import './index.css'
import './transcript.css'
import './decision.css'
import './permission.css'
import './search.css'
import './session.css'
import './session-rail.css'
import './commands-strip.css'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { ReposListResponse } from '../../shared/ipc'
import { renderSessionsPicker, type SessionsPickerState } from './sessions'
import { jumpToLatest, renderTranscript } from './transcript'
import {
  closeTranscriptTail,
  handleVisibilityChange,
  openTranscriptTail,
  registerTranscriptRedraw,
  resumeFollowing,
  toggleFollow,
  transcriptScreenState,
} from './transcript-tail'
import { agentLabel, sessionLabel } from '../../shared/sessions/label'
import { changeSearchScope, openSearch, registerSearchRedraw, renderSearch, searchScreenState, submitSearch } from './search'
import { initDecision, openDecisionDialog } from './decision/controller'
import { initPermissions } from './permission/controller'
import { initSession } from './session/controller'
import { router } from './router/router'
import { routeForView, containerFor, isReactScreen, viewFromMatch, type View } from './router/legacy-view'
import { createQueryClient, ipcQueryOptions } from './data/query'
import { connectQueryCache } from './data/subscriptions'
import { connectItemActionPruning } from './board/screen'
import { mountReact } from './react/mount'
import { themeStore } from './theme/store'
import { registerLegacyActions } from './shell/legacy-actions'
import { trackLastRoute } from './shell/prefs'
import { initSidebarCollapsed, listNavigatorFor, openPalette, setRenaming, toggleSidebarCollapsed } from './shell/stores'
import { shellPrefs, setSidebarCollapsed } from './shell/prefs'
import { installKeyboardMap } from './shell/keyboard'
import { liveSessionKeys, selectSession, startNewSession } from './session/controller'
import { selectedSession } from './session/selection'
import { toast } from 'sonner'
import { shouldRedirectToSetup } from './setup/launch-redirect'

const app = document.querySelector<HTMLDivElement>('#app')
const shellRoot = document.querySelector<HTMLDivElement>('#shell-root')
const reposContainer = document.querySelector<HTMLDivElement>('#repositories-view')
const sessionContainer = document.querySelector<HTMLDivElement>('#session-view')
const reactRootContainer = document.querySelector<HTMLDivElement>('#react-root')

let sessionsState: SessionsPickerState = { status: 'loading' }

// The router is the one source of truth for which screen is on top (#316) —
// never a `let view` this module holds independently.
function currentView(): View {
  const matches = router.state.matches
  const leaf = matches[matches.length - 1]
  if (leaf === undefined) return { screen: 'board' }
  return viewFromMatch(leaf.routeId, leaf.params, leaf.search as Record<string, unknown>)
}

function drawViews(view: View): void {
  const active = containerFor(view)
  if (reposContainer) reposContainer.hidden = active !== 'repositories'
  // The session container is hidden rather than cleared on a route switch,
  // so the stream keeps rendering in the background.
  if (sessionContainer) sessionContainer.hidden = active !== 'session'
  // #react-root shows for every React screen (Board, Repositories, Settings,
  // Backlog, Setup, About, Needs you).
  if (reactRootContainer) reactRootContainer.hidden = !isReactScreen(view)
}

function drawRepositories(view: View): void {
  if (!reposContainer) return
  if (view.screen === 'sessions') {
    renderSessionsPicker(reposContainer, view.repoId, repoLabelFor(view.repoId), sessionsState)
  } else if (view.screen === 'search') {
    renderSearch(reposContainer, searchScreenState())
  } else if (view.screen === 'transcript') {
    renderTranscript(reposContainer, transcriptScreenState())
  }
}

function draw(): void {
  const view = currentView()
  drawViews(view)
  drawRepositories(view)
}

// Navigates, then lets `router.subscribe('onResolved', draw)` repaint — the
// one seam asserting the loose `RouteDescriptor` against `navigate`'s real signature.
async function navigateTo(next: View): Promise<void> {
  await router.navigate(routeForView(next) as Parameters<typeof router.navigate>[0])
}

/** The one place renderer code outside `repositories/` still needs the
 *  repository list — `repoLabelFor`/`readyRepoIds` below — reads it from the
 *  query cache rather than a `state` this module tracks itself (#319): the
 *  Repositories screen's own `useIpcQuery('repos:list')` is what keeps this
 *  cache populated day to day, and `boot()`'s own `fetchQuery` below
 *  guarantees it is populated at least once before anything reads it. */
function currentRepositories(client: ReturnType<typeof createQueryClient>): readonly RepositoryEntry[] {
  const data = client.getQueryData<ReposListResponse>(ipcQueryOptions('repos:list').queryKey)
  return data?.ok === true ? data.repositories : []
}

function repoLabelFor(id: RepoId): string {
  const entry = currentRepositories(queryClient).find((repository) => repository.id === id)
  if (entry === undefined) return id
  return 'config' in entry ? entry.config.repo : entry.displayName
}

async function loadSessions(): Promise<void> {
  sessionsState = { status: 'loading' }
  draw()
  try {
    const scan = await window.port.sessionsScan()
    sessionsState = scan.ok ? { status: 'ready', scan } : { status: 'error', kind: scan.kind, message: scan.message }
  } catch (error) {
    console.error('Failed to scan sessions', error)
    sessionsState = { status: 'unreachable' }
  }
  draw()
}

async function handleOpenSessions(repoId: RepoId): Promise<void> {
  await navigateTo({ screen: 'sessions', repoId })
  void loadSessions()
}

// #83: "stage plus #N, else the session title", from the already-loaded
// sessionsState — falls back to the raw id only when the picker is stale.
function titleFor(sessionId: string, agentId: string | null): string {
  const scan = sessionsState.status === 'ready' ? sessionsState.scan : null
  if (agentId !== null) {
    const agent = scan?.agents.find((a) => a.agentId === agentId)
    return agent !== undefined ? agentLabel(agent) : `agent-${agentId}`
  }
  const session = scan?.sessions.find((s) => s.sessionId === sessionId)
  return session !== undefined ? sessionLabel(session) : sessionId
}

async function handleOpenTranscript(sessionId: string, agentId: string): Promise<void> {
  const normalizedAgentId = agentId === '' ? null : agentId
  const title = titleFor(sessionId, normalizedAgentId)
  await navigateTo({ screen: 'transcript', sessionId, agentId: normalizedAgentId, title, from: 'sessions', focusIndex: null })
  void openTranscriptTail(sessionId, normalizedAgentId, title, null)
}

// A search hit's own open route — `label` is already resolved, so this
// never re-derives a title from the (possibly stale) sessions picker.
async function handleOpenSearchHit(sessionId: string, agentId: string, entryIndex: number, label: string): Promise<void> {
  const normalizedAgentId = agentId === '' ? null : agentId
  await navigateTo({ screen: 'transcript', sessionId, agentId: normalizedAgentId, title: label, from: 'search', focusIndex: entryIndex })
  void openTranscriptTail(sessionId, normalizedAgentId, label, entryIndex)
}

async function handleBackToSessions(): Promise<void> {
  const view = currentView()
  if (view.screen !== 'transcript') return
  const { sessionId, from } = view
  closeTranscriptTail()

  if (from === 'search') {
    const search = searchScreenState()
    await navigateTo({ screen: 'search', repoId: search.repoId })
    return
  }

  // Reopens the picker from memory, no fresh round trip; rescan-sessions
  // covers a deliberate refresh.
  const repoId = sessionsState.status === 'ready' ? (sessionsState.scan.sessions.find((s) => s.sessionId === sessionId)?.repoId ?? null) : null
  await navigateTo(repoId !== null ? { screen: 'sessions', repoId } : { screen: 'repos' })
}

async function handleOpenSearch(repoId: RepoId): Promise<void> {
  await navigateTo({ screen: 'search', repoId })
  openSearch(repoId, repoLabelFor(repoId))
}

async function handleBackFromSearch(): Promise<void> {
  const view = currentView()
  if (view.screen !== 'search') return
  await navigateTo({ screen: 'sessions', repoId: view.repoId })
}

function handleSearchScopeChange(value: string): void {
  const search = searchScreenState()
  changeSearchScope(value === 'all' ? { kind: 'all' } : { kind: 'repo', repoId: search.repoId })
}

document.addEventListener('visibilitychange', handleVisibilityChange)

app?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const action = target.dataset.action
  if (action === 'back-to-repos') void navigateTo({ screen: 'repos' })
  else if (action === 'rescan-sessions') void loadSessions()
  else if (action === 'open-transcript' && target.dataset.sessionId !== undefined) void handleOpenTranscript(target.dataset.sessionId, target.dataset.agentId ?? '')
  else if (action === 'back-to-sessions') void handleBackToSessions()
  else if (action === 'open-search' && target.dataset.repoId) void handleOpenSearch(target.dataset.repoId as RepoId)
  else if (action === 'search-back') void handleBackFromSearch()
  else if (action === 'search-hit' && target.dataset.sessionId !== undefined) {
    void handleOpenSearchHit(target.dataset.sessionId, target.dataset.agentId ?? '', Number(target.dataset.entryIndex ?? '0'), target.dataset.label ?? '')
  }
  else if (action === 'toggle-follow') toggleFollow()
  else if (action === 'jump-to-latest') jumpToLatest()
  else if (action === 'retry-transcript') resumeFollowing()
  else if (action?.startsWith('decide-')) openDecisionDialog(target)
})

app?.addEventListener('change', (event) => {
  const target = event.target
  if (target instanceof HTMLSelectElement && target.dataset.field === 'search-scope') handleSearchScopeChange(target.value)
})

app?.addEventListener('submit', (event) => {
  const target = event.target
  if (!(target instanceof HTMLFormElement) || target.dataset.action !== 'search-submit') return
  event.preventDefault()
  const input = target.querySelector<HTMLInputElement>('[data-field="search-query"]')
  void submitSearch(input?.value ?? '')
})

registerSearchRedraw(draw)
registerTranscriptRedraw(draw)

// Boot order: theme, query client, push-cache wiring, React mount, legacy init.
themeStore().apply()
const queryClient = createQueryClient()
connectQueryCache(queryClient)
connectItemActionPruning(queryClient)
initSidebarCollapsed(shellPrefs().sidebarCollapsed)
if (shellRoot && reactRootContainer) mountReact(shellRoot, reactRootContainer, queryClient)

installKeyboardMap({
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
    const view = currentView()
    const screen = view.screen === 'board' ? 'board' : view.screen === 'backlog' ? 'backlog' : view.screen === 'needsYou' ? 'needsYou' : null
    return screen !== null ? listNavigatorFor(screen) : undefined
  },
  noReadyRepoToast: () => toast('Register a repository to start a session.'),
})

async function boot(): Promise<void> {
  router.subscribe('onResolved', () => {
    draw()
    trackLastRoute(router.state.location.pathname)
  })
  // Restores the last screen on a fresh launch; an explicit deep link wins.
  const lastRoute = shellPrefs().lastRoute
  if (lastRoute !== null && (location.hash === '' || location.hash === '#/')) router.history.replace(`#${lastRoute}`)
  await router.load()
  draw()
  if (await shouldRedirectToSetup(queryClient)) await navigateTo({ screen: 'setup' })
  // Populates the `repos:list` cache at least once, regardless of which
  // screen the app lands on — `repoLabelFor`/`readyRepoIds` above read it,
  // and `repositories/screen.tsx`'s own `useIpcQuery` keeps it current from
  // here on.
  void queryClient.fetchQuery(ipcQueryOptions('repos:list'))
  if (app) initDecision(app, queryClient)
  if (app) initPermissions(app)
  registerLegacyActions({ openSessions: (repoId) => void handleOpenSessions(repoId) })
  if (sessionContainer) initSession(sessionContainer, { show: () => void navigateTo({ screen: 'session' }) })
}
void boot()

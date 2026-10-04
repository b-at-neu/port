import './styles/app.css'
import './index.css'
import './transcript.css'
import './board.css'
import './claim.css'
import './gate.css'
import './permission.css'
import './search.css'
import './session.css'
import './session-rail.css'
import './commands-strip.css'
import type { AppInfo } from '../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { BoardSnapshot, GroupBy } from '../../shared/board/types'
import { render, type RegistryBanner, type RendererState } from './repositories'
import type { WorktreeSectionState } from './worktrees'
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
import { render as renderBoard, type BoardViewState } from './board/view'
import { handleItemAction, pruneItemActionStates } from './board/actions'
import { handleDispatchClick } from './board/dispatch'
import { handleRelayCopy, pruneRelayStates, relayKeyOf, setRelayAnswer, toggleRelayExpanded } from './board/relay'
import type { OperatorAction } from '../../shared/actions/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RelayPending } from '../../shared/relay/types'
import { initClaim, openClaimDialog } from './claim/controller'
import { initGate, openGateDialog, openReviewDialog } from './gate/controller'
import { initPermissions } from './permission/controller'
import { initRuntime } from './runtime'
import { initSession, sessionsTabText } from './session/controller'
import { router } from './router/router'
import { routeForView, tabFor, viewFromMatch, type Tab, type View } from './router/legacy-view'
import { createQueryClient, ipcQueryOptions, observeIpcQuery } from './data/query'
import { connectQueryCache } from './data/subscriptions'
import { mountReact } from './react/mount'
import { themeStore } from './theme/store'

const app = document.querySelector<HTMLDivElement>('#app')
const runtimeStrip = document.querySelector<HTMLDivElement>('#runtime-strip')
const nav = document.querySelector<HTMLDivElement>('#nav')
const boardContainer = document.querySelector<HTMLDivElement>('#board-view')
const reposContainer = document.querySelector<HTMLDivElement>('#repositories-view')
const sessionContainer = document.querySelector<HTMLDivElement>('#session-view')
const reactRootContainer = document.querySelector<HTMLDivElement>('#react-root')

let state: RendererState = { status: 'loading', repositories: [] }
let worktreeSections = new Map<RepoId, WorktreeSectionState>()
let boardState: BoardViewState = { status: 'loading', snapshot: null, groupBy: 'stage', refreshing: false, now: new Date() }
let sessionsState: SessionsPickerState = { status: 'loading' }

// The router is the one source of truth for which screen is on top (#316) —
// never a `let view` this module holds independently.
function currentView(): View {
  const matches = router.state.matches
  const leaf = matches[matches.length - 1]
  if (leaf === undefined) return { screen: 'board' }
  return viewFromMatch(leaf.routeId, leaf.params, leaf.search as Record<string, unknown>)
}

const TAB_LABELS: Readonly<Record<'board' | 'repositories' | 'settings', string>> = { board: 'Board', repositories: 'Repositories', settings: 'Settings' }

function drawNav(view: View): void {
  if (!nav) return
  const active = tabFor(view)
  nav.textContent = ''
  for (const tab of ['board', 'repositories', 'session', 'settings'] as const) {
    const button = document.createElement('button')
    button.className = tab === active ? 'nav-tab nav-tab--active' : 'nav-tab'
    button.textContent = tab === 'session' ? sessionsTabText() : TAB_LABELS[tab]
    button.dataset.action = 'view-switch'
    button.dataset.view = tab
    nav.appendChild(button)
  }
}

function drawViews(view: View): void {
  const active = tabFor(view)
  if (boardContainer) boardContainer.hidden = active !== 'board'
  if (reposContainer) reposContainer.hidden = active !== 'repositories'
  // The session container is hidden rather than cleared on a tab switch, so
  // the stream keeps rendering in the background.
  if (sessionContainer) sessionContainer.hidden = active !== 'session'
  // #react-root shows only for the one React screen this ticket ships.
  if (reactRootContainer) reactRootContainer.hidden = active !== 'settings'
}

function drawRepositories(view: View): void {
  if (!reposContainer) return
  if (view.screen === 'repos') {
    render(reposContainer, { ...state, worktreeSections })
  } else if (view.screen === 'sessions') {
    renderSessionsPicker(reposContainer, view.repoId, repoLabelFor(view.repoId), sessionsState)
  } else if (view.screen === 'search') {
    renderSearch(reposContainer, searchScreenState())
  } else if (view.screen === 'transcript') {
    renderTranscript(reposContainer, transcriptScreenState())
  }
}

function drawBoard(): void {
  if (!boardContainer) return
  renderBoard(boardContainer, { ...boardState, now: new Date() })
}

function draw(): void {
  const view = currentView()
  drawNav(view)
  drawViews(view)
  drawRepositories(view)
  drawBoard()
}

// Navigates, then lets `router.subscribe('onResolved', draw)` repaint — the
// one seam asserting the loose `RouteDescriptor` against `navigate`'s real
// signature (`data/invoke.ts`'s own "one type assertion" idiom).
async function navigateTo(next: View): Promise<void> {
  await router.navigate(routeForView(next) as Parameters<typeof router.navigate>[0])
}

function bannerFor(kind: string): RegistryBanner['reason'] {
  if (kind === 'registry-malformed') return 'malformed'
  if (kind === 'registry-unsupported-version') return 'unsupported-version'
  return 'unreadable'
}

async function refreshRepositories(): Promise<void> {
  state = { ...state, status: 'loading' }
  drawRepositories(currentView())
  try {
    const [info, result] = await Promise.all([window.port.appInfo(), window.port.reposList()])
    applyListResult(info, result)
  } catch (error) {
    console.error('Failed to reach the main process', error)
    state = { status: 'error', repositories: [] }
    drawRepositories(currentView())
  }
}

function applyListResult(appInfo: AppInfo, result: Awaited<ReturnType<typeof window.port.reposList>>): void {
  if (!result.ok) {
    state = { status: 'ready', repositories: [], appInfo, registryBanner: { path: 'registry.json', reason: bannerFor(result.kind) } }
    drawRepositories(currentView())
    return
  }
  state = { status: 'ready', repositories: result.repositories, appInfo }
  drawRepositories(currentView())
}

function highlight(id: RepoId, repositories: readonly RepositoryEntry[], notice: string): void {
  state = { ...state, status: 'ready', repositories, highlighted: id, notice }
  drawRepositories(currentView())
  setTimeout(() => {
    state = { ...state, highlighted: undefined, notice: undefined }
    drawRepositories(currentView())
  }, 3000)
}

async function handleAdd(): Promise<void> {
  state = { ...state, status: 'loading' }
  drawRepositories(currentView())
  try {
    const result = await window.port.reposAdd()
    if (!result.ok) {
      state = { ...state, status: 'ready', registryBanner: { path: 'registry.json', reason: bannerFor(result.kind) } }
      drawRepositories(currentView())
      return
    }
    if (result.outcome === 'cancelled') {
      state = { ...state, status: 'ready' }
      drawRepositories(currentView())
      return
    }
    if (result.outcome === 'already-registered') {
      highlight(result.existing, result.repositories, 'Already added.')
      return
    }
    state = { ...state, status: 'ready', repositories: result.repositories, registryBanner: undefined }
    drawRepositories(currentView())
  } catch (error) {
    console.error('Failed to add a repository', error)
    state = { status: 'error', repositories: [] }
    drawRepositories(currentView())
  }
}

async function handleRemove(id: RepoId): Promise<void> {
  state = { ...state, status: 'loading' }
  drawRepositories(currentView())
  try {
    const result = await window.port.reposRemove({ id })
    if (!result.ok) {
      state = { ...state, status: 'ready' }
      drawRepositories(currentView())
      return
    }
    state = { ...state, status: 'ready', repositories: result.repositories }
    drawRepositories(currentView())
  } catch (error) {
    console.error('Failed to remove a repository', error)
    state = { status: 'error', repositories: [] }
    drawRepositories(currentView())
  }
}

// Per-repository inspection state in its own Map (never blanking one card
// when another refreshes); never polls — a report runs only on request.
async function handleInspectWorktrees(id: RepoId): Promise<void> {
  worktreeSections = new Map(worktreeSections).set(id, { status: 'loading' })
  drawRepositories(currentView())
  try {
    const report = await window.port.worktreesReport({ id })
    worktreeSections = new Map(worktreeSections).set(id, { status: 'done', report })
  } catch (error) {
    console.error('Failed to inspect worktrees', error)
    worktreeSections = new Map(worktreeSections).set(id, {
      status: 'done',
      report: { ok: false, kind: 'spawn-failed', message: 'Failed to reach the main process', readAt: new Date().toISOString() },
    })
  }
  drawRepositories(currentView())
}

function applySnapshot(snapshot: BoardSnapshot): void {
  pruneItemActionStates(snapshot)
  pruneRelayStates(snapshot.relay)
  boardState = { ...boardState, status: 'ready', snapshot, refreshing: false }
  drawBoard()
}

// Resolves the dataset key's own RelayPending from the live snapshot.
function findRelayPending(key: string): RelayPending | null {
  const relay = boardState.snapshot?.relay
  if (relay === undefined || !relay.ok) return null
  return relay.pending.find((p) => relayKeyOf(p) === key) ?? null
}

function handleRelayToggleClick(target: HTMLElement): void {
  const key = target.dataset.key
  if (key === undefined) return
  const pending = findRelayPending(key)
  if (pending === null) return
  toggleRelayExpanded(pending)
  drawBoard()
}

function handleRelayCopyClick(target: HTMLElement): void {
  const key = target.dataset.key
  if (key === undefined) return
  const pending = findRelayPending(key)
  if (pending === null) return
  void handleRelayCopy(pending, drawBoard)
}

function handleRelayAnswerInput(target: HTMLTextAreaElement): void {
  const { key, index } = target.dataset
  if (key === undefined || index === undefined) return
  const pending = findRelayPending(key)
  if (pending === null) return
  setRelayAnswer(pending, Number(index), target.value)
  drawBoard()
}

// Reads the board through the query cache (#316) — `connectQueryCache`
// feeds `board:update` pushes into the same cache, so this one observer
// reaches `applySnapshot` for both the initial fetch and every later push.
function initBoard(client: ReturnType<typeof createQueryClient>): void {
  observeIpcQuery(client, 'board:snapshot', undefined, (result) => {
    if (result.status === 'success') applySnapshot(result.data)
    else if (result.status === 'error') {
      console.error('Failed to reach the main process', result.error)
      boardState = { ...boardState, status: 'error' }
      drawBoard()
    }
  })
}

async function handleBoardRefresh(client: ReturnType<typeof createQueryClient>): Promise<void> {
  boardState = { ...boardState, refreshing: true }
  drawBoard()
  try {
    const snapshot = await window.port.boardRefresh({})
    client.setQueryData(ipcQueryOptions('board:snapshot').queryKey, snapshot)
  } catch (error) {
    console.error('Failed to refresh the board', error)
    boardState = { ...boardState, refreshing: false }
    drawBoard()
  }
}

// The action controller's own click entry point (rows.ts's own buttons).
function handleItemActionClick(target: HTMLElement): void {
  const action = target.dataset.action?.slice('item-'.length) as OperatorAction | undefined
  const { repoId, number, kind, stage } = target.dataset
  if (!action || !repoId || !number || !kind) return
  void handleItemAction({ repoId: repoId as RepoId, kind: kind as 'issue' | 'pull-request', number: Number(number), action, expectedStage: (stage || null) as LabelKey | null, redraw: drawBoard })
}

// The plan gate's own row entry point (board/rows.ts's Review plan button).
function handleGateReviewClick(target: HTMLElement): void {
  const { repoId, number } = target.dataset
  if (!repoId || !number) return
  openReviewDialog(repoId as RepoId, Number(number))
}

function toggleGroupBy(): void {
  const next: GroupBy = boardState.groupBy === 'stage' ? 'repo' : 'stage'
  boardState = { ...boardState, groupBy: next }
  drawBoard()
}

// Switching tabs always lands on that tab's top screen rather than
// preserving a drill-down the operator explicitly left.
async function switchTab(tab: Tab): Promise<void> {
  const next: View = tab === 'board' ? { screen: 'board' } : tab === 'session' ? { screen: 'session' } : tab === 'settings' ? { screen: 'settings' } : { screen: 'repos' }
  await navigateTo(next)
}

function repoLabelFor(id: RepoId): string {
  const entry = state.repositories.find((repository) => repository.id === id)
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

async function handleBackToRepos(): Promise<void> {
  await navigateTo({ screen: 'repos' })
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
  if (action === 'view-switch' && target.dataset.view) {
    void switchTab(target.dataset.view as Tab)
    return
  }
  if (action === 'add') void handleAdd()
  else if (action === 'rescan') void refreshRepositories()
  else if (action === 'remove' && target.dataset.repoId) void handleRemove(target.dataset.repoId as RepoId)
  else if (action === 'inspect-worktrees' && target.dataset.repoId) void handleInspectWorktrees(target.dataset.repoId as RepoId)
  else if (action === 'transcripts' && target.dataset.repoId) void handleOpenSessions(target.dataset.repoId as RepoId)
  else if (action === 'back-to-repos') void handleBackToRepos()
  else if (action === 'rescan-sessions') void loadSessions()
  else if (action === 'open-transcript' && target.dataset.sessionId !== undefined) void handleOpenTranscript(target.dataset.sessionId, target.dataset.agentId ?? '')
  else if (action === 'back-to-sessions') void handleBackToSessions()
  else if (action === 'open-search' && target.dataset.repoId) void handleOpenSearch(target.dataset.repoId as RepoId)
  else if (action === 'search-back') void handleBackFromSearch()
  else if (action === 'search-hit' && target.dataset.sessionId !== undefined) {
    void handleOpenSearchHit(target.dataset.sessionId, target.dataset.agentId ?? '', Number(target.dataset.entryIndex ?? '0'), target.dataset.label ?? '')
  }
  else if (action === 'board-refresh') void handleBoardRefresh(queryClient)
  else if (action === 'board-group-toggle') toggleGroupBy()
  else if (action === 'toggle-follow') toggleFollow()
  else if (action === 'jump-to-latest') jumpToLatest()
  else if (action === 'retry-transcript') resumeFollowing()
  else if (action === 'claim-open') openClaimDialog()
  else if (action === 'gate-open') openGateDialog()
  else if (action === 'gate-review') handleGateReviewClick(target)
  else if (action === 'relay-toggle') handleRelayToggleClick(target)
  else if (action === 'relay-copy') handleRelayCopyClick(target)
  else if (action?.startsWith('item-')) handleItemActionClick(target)
  else if (action?.startsWith('dispatch-')) handleDispatchClick(target, boardState.snapshot, drawBoard)
  else {
    const row = target.closest<HTMLElement>('.board-row')
    if (row?.dataset.url) window.open(row.dataset.url, '_blank')
  }
})

app?.addEventListener('change', (event) => {
  const target = event.target
  if (target instanceof HTMLSelectElement && target.dataset.field === 'search-scope') handleSearchScopeChange(target.value)
})

app?.addEventListener('input', (event) => {
  const target = event.target
  if (target instanceof HTMLTextAreaElement && target.classList.contains('relay-banner__answer')) handleRelayAnswerInput(target)
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

// Boot order (#316): theme, query client, push-cache wiring, React mount,
// then the legacy screens' own init.
themeStore().apply()
const queryClient = createQueryClient()
connectQueryCache(queryClient)
if (reactRootContainer) mountReact(reactRootContainer, queryClient)

async function boot(): Promise<void> {
  router.subscribe('onResolved', draw)
  await router.load()
  draw()
  void refreshRepositories()
  initBoard(queryClient)
  if (app) initClaim(app)
  if (app) initGate(app)
  if (app) initPermissions(app)
  if (runtimeStrip) initRuntime(runtimeStrip)
  if (sessionContainer) initSession(sessionContainer, { show: () => void switchTab('session'), onNavChange: () => drawNav(currentView()) })
}
void boot()

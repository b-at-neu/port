import './index.css'
import './transcript.css'
import './board.css'
import './claim.css'
import './search.css'
import type { AppInfo } from '../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { BoardSnapshot, GroupBy } from '../../shared/board/types'
import { render } from './repositories'
import type { RegistryBanner, RendererState } from './repositories'
import type { WorktreeSectionState } from './worktrees'
import { renderSessionsPicker } from './sessions'
import type { SessionsPickerState } from './sessions'
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
import { render as renderBoard } from './board/view'
import type { BoardViewState } from './board/view'
import { handleItemAction, pruneItemActionStates } from './board/actions'
import type { OperatorAction } from '../../shared/actions/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import { initClaim, openClaimDialog } from './claim/controller'

const app = document.querySelector<HTMLDivElement>('#app')
const nav = document.querySelector<HTMLDivElement>('#nav')
const boardContainer = document.querySelector<HTMLDivElement>('#board-view')
const reposContainer = document.querySelector<HTMLDivElement>('#repositories-view')

/** Which screen is on top. `board` (#80) and `repos` are the nav bar's two
 *  tabs; `sessions` and `transcript` are #83's picker and viewer, reached
 *  only from a ready repository card and never bookmarked (no router, no
 *  URL state) — both nest under the 'Repositories' tab, never their own. */
type View =
  | { readonly screen: 'board' }
  | { readonly screen: 'repos' }
  | { readonly screen: 'sessions'; readonly repoId: RepoId; readonly repoLabel: string }
  | { readonly screen: 'search'; readonly repoId: RepoId; readonly repoLabel: string }
  /** `from` is where `‹ Back` returns to -- the sessions picker normally,
   *  the search screen (already in memory, no requery) when a hit opened
   *  this transcript. */
  | { readonly screen: 'transcript'; readonly sessionId: string; readonly agentId: string | null; readonly title: string; readonly from: 'sessions' | 'search'; readonly focusIndex: number | null }

/** Every screen except `board` lives under the 'Repositories' tab — drilling
 *  into a session or transcript never looks like it left that tab. */
function tabFor(view: View): 'board' | 'repositories' {
  return view.screen === 'board' ? 'board' : 'repositories'
}

let state: RendererState = { status: 'loading', repositories: [] }
let worktreeSections = new Map<RepoId, WorktreeSectionState>()
let view: View = { screen: 'board' }
let boardState: BoardViewState = { status: 'loading', snapshot: null, groupBy: 'stage', refreshing: false, now: new Date() }
let sessionsState: SessionsPickerState = { status: 'loading' }

function drawNav(): void {
  if (!nav) return
  const active = tabFor(view)
  nav.textContent = ''
  for (const tab of ['board', 'repositories'] as const) {
    const button = document.createElement('button')
    button.className = tab === active ? 'nav-tab nav-tab--active' : 'nav-tab'
    button.textContent = tab === 'board' ? 'Board' : 'Repositories'
    button.dataset.action = 'view-switch'
    button.dataset.view = tab
    nav.appendChild(button)
  }
}

function drawViews(): void {
  const active = tabFor(view)
  if (boardContainer) boardContainer.hidden = active !== 'board'
  if (reposContainer) reposContainer.hidden = active !== 'repositories'
}

function drawRepositories(): void {
  if (!reposContainer) return
  if (view.screen === 'repos') {
    render(reposContainer, { ...state, worktreeSections })
  } else if (view.screen === 'sessions') {
    renderSessionsPicker(reposContainer, view.repoId, view.repoLabel, sessionsState)
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
  drawNav()
  drawViews()
  drawRepositories()
  drawBoard()
}

function bannerFor(kind: string): RegistryBanner['reason'] {
  if (kind === 'registry-malformed') return 'malformed'
  if (kind === 'registry-unsupported-version') return 'unsupported-version'
  return 'unreadable'
}

async function refreshRepositories(): Promise<void> {
  state = { ...state, status: 'loading' }
  drawRepositories()
  try {
    const [info, result] = await Promise.all([window.port.appInfo(), window.port.reposList()])
    applyListResult(info, result)
  } catch (error) {
    console.error('Failed to reach the main process', error)
    state = { status: 'error', repositories: [] }
    drawRepositories()
  }
}

function applyListResult(appInfo: AppInfo, result: Awaited<ReturnType<typeof window.port.reposList>>): void {
  if (!result.ok) {
    state = { status: 'ready', repositories: [], appInfo, registryBanner: { path: 'registry.json', reason: bannerFor(result.kind) } }
    drawRepositories()
    return
  }
  state = { status: 'ready', repositories: result.repositories, appInfo }
  drawRepositories()
}

function highlight(id: RepoId, repositories: readonly RepositoryEntry[], notice: string): void {
  state = { ...state, status: 'ready', repositories, highlighted: id, notice }
  drawRepositories()
  setTimeout(() => {
    state = { ...state, highlighted: undefined, notice: undefined }
    drawRepositories()
  }, 3000)
}

async function handleAdd(): Promise<void> {
  state = { ...state, status: 'loading' }
  drawRepositories()
  try {
    const result = await window.port.reposAdd()
    if (!result.ok) {
      state = { ...state, status: 'ready', registryBanner: { path: 'registry.json', reason: bannerFor(result.kind) } }
      drawRepositories()
      return
    }
    if (result.outcome === 'cancelled') {
      state = { ...state, status: 'ready' }
      drawRepositories()
      return
    }
    if (result.outcome === 'already-registered') {
      highlight(result.existing, result.repositories, 'Already added.')
      return
    }
    state = { ...state, status: 'ready', repositories: result.repositories, registryBanner: undefined }
    drawRepositories()
  } catch (error) {
    console.error('Failed to add a repository', error)
    state = { status: 'error', repositories: [] }
    drawRepositories()
  }
}

async function handleRemove(id: RepoId): Promise<void> {
  state = { ...state, status: 'loading' }
  drawRepositories()
  try {
    const result = await window.port.reposRemove({ id })
    if (!result.ok) {
      state = { ...state, status: 'ready' }
      drawRepositories()
      return
    }
    state = { ...state, status: 'ready', repositories: result.repositories }
    drawRepositories()
  } catch (error) {
    console.error('Failed to remove a repository', error)
    state = { status: 'error', repositories: [] }
    drawRepositories()
  }
}

/** Holds the per-repository inspection state in its own `Map` (never
 *  blanking one card when another refreshes) and never polls — a
 *  `worktrees:report` round trip runs only when the operator asks
 *  (Decision 5). */
async function handleInspectWorktrees(id: RepoId): Promise<void> {
  worktreeSections = new Map(worktreeSections).set(id, { status: 'loading' })
  drawRepositories()
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
  drawRepositories()
}

function applySnapshot(snapshot: BoardSnapshot): void {
  pruneItemActionStates(snapshot)
  boardState = { ...boardState, status: 'ready', snapshot, refreshing: false }
  drawBoard()
}

async function initBoard(): Promise<void> {
  try {
    const snapshot = await window.port.boardSnapshot()
    applySnapshot(snapshot)
  } catch (error) {
    console.error('Failed to reach the main process', error)
    boardState = { ...boardState, status: 'error' }
    drawBoard()
  }
  window.port.onBoardUpdate((snapshot) => applySnapshot(snapshot))
}

async function handleBoardRefresh(): Promise<void> {
  boardState = { ...boardState, refreshing: true }
  drawBoard()
  try {
    const snapshot = await window.port.boardRefresh({})
    applySnapshot(snapshot)
  } catch (error) {
    console.error('Failed to refresh the board', error)
    boardState = { ...boardState, refreshing: false }
    drawBoard()
  }
}

/** The action controller's own click entry point — dataset carries `repoId`/`kind`/`number`/`stage` verbatim from `rows.ts`'s own buttons. */
function handleItemActionClick(target: HTMLElement): void {
  const action = target.dataset.action?.slice('item-'.length) as OperatorAction | undefined
  const { repoId, number, kind, stage } = target.dataset
  if (!action || !repoId || !number || !kind) return
  void handleItemAction({ repoId: repoId as RepoId, kind: kind as 'issue' | 'pull-request', number: Number(number), action, expectedStage: (stage || null) as LabelKey | null, redraw: drawBoard })
}

function toggleGroupBy(): void {
  const next: GroupBy = boardState.groupBy === 'stage' ? 'repo' : 'stage'
  boardState = { ...boardState, groupBy: next }
  drawBoard()
}

/** Switching tabs always lands on that tab's top screen — 'board', or the
 *  repositories list — rather than trying to preserve a drill-down (a
 *  session/transcript screen) across a tab the operator explicitly left. */
function switchTab(tab: 'board' | 'repositories'): void {
  view = tab === 'board' ? { screen: 'board' } : { screen: 'repos' }
  draw()
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

function handleOpenSessions(repoId: RepoId): void {
  view = { screen: 'sessions', repoId, repoLabel: repoLabelFor(repoId) }
  void loadSessions()
}

function handleBackToRepos(): void {
  view = { screen: 'repos' }
  draw()
}

/** #83's UX spec: "stage plus #N, else the session title" — resolved from
 *  the already-loaded `sessionsState` (`SessionRecord`/`AgentRecord`), never
 *  the raw id, so the transcript header and the back-to-sessions flow show
 *  something scannable rather than an opaque `sessionId`/`agent-<id>`. Falls
 *  back to the raw id only when the picker hasn't loaded (or is stale) yet. */
function titleFor(sessionId: string, agentId: string | null): string {
  const scan = sessionsState.status === 'ready' ? sessionsState.scan : null
  if (agentId !== null) {
    const agent = scan?.agents.find((a) => a.agentId === agentId)
    return agent !== undefined ? agentLabel(agent) : `agent-${agentId}`
  }
  const session = scan?.sessions.find((s) => s.sessionId === sessionId)
  return session !== undefined ? sessionLabel(session) : sessionId
}

function handleOpenTranscript(sessionId: string, agentId: string): void {
  const normalizedAgentId = agentId === '' ? null : agentId
  const title = titleFor(sessionId, normalizedAgentId)
  view = { screen: 'transcript', sessionId, agentId: normalizedAgentId, title, from: 'sessions', focusIndex: null }
  void openTranscriptTail(sessionId, normalizedAgentId, title, null)
}

/** A search hit's own open route — `label` is the group's already-resolved
 *  `sessionLabel`/`agentLabel`, so this never re-derives a title the way
 *  `handleOpenTranscript` does from the (possibly stale) sessions picker. */
function handleOpenSearchHit(sessionId: string, agentId: string, entryIndex: number, label: string): void {
  const normalizedAgentId = agentId === '' ? null : agentId
  view = { screen: 'transcript', sessionId, agentId: normalizedAgentId, title: label, from: 'search', focusIndex: entryIndex }
  void openTranscriptTail(sessionId, normalizedAgentId, label, entryIndex)
}

function handleBackToSessions(): void {
  if (view.screen !== 'transcript') return
  const { sessionId, from } = view
  closeTranscriptTail()

  if (from === 'search') {
    const search = searchScreenState()
    view = { screen: 'search', repoId: search.repoId, repoLabel: search.repoLabel }
    draw()
    return
  }

  // The picker's own state is still in memory from the last scan — reopen
  // it without a fresh round trip; `rescan-sessions` covers a deliberate
  // refresh.
  const repoId = sessionsState.status === 'ready' ? (sessionsState.scan.sessions.find((s) => s.sessionId === sessionId)?.repoId ?? null) : null
  view = repoId !== null ? { screen: 'sessions', repoId, repoLabel: repoLabelFor(repoId) } : { screen: 'repos' }
  draw()
}

function handleOpenSearch(repoId: RepoId): void {
  view = { screen: 'search', repoId, repoLabel: repoLabelFor(repoId) }
  openSearch(repoId, repoLabelFor(repoId))
}

function handleBackFromSearch(): void {
  if (view.screen !== 'search') return
  view = { screen: 'sessions', repoId: view.repoId, repoLabel: view.repoLabel }
  draw()
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
    switchTab(target.dataset.view as 'board' | 'repositories')
    return
  }
  if (action === 'add') void handleAdd()
  else if (action === 'rescan') void refreshRepositories()
  else if (action === 'remove' && target.dataset.repoId) void handleRemove(target.dataset.repoId as RepoId)
  else if (action === 'inspect-worktrees' && target.dataset.repoId) void handleInspectWorktrees(target.dataset.repoId as RepoId)
  else if (action === 'transcripts' && target.dataset.repoId) handleOpenSessions(target.dataset.repoId as RepoId)
  else if (action === 'back-to-repos') handleBackToRepos()
  else if (action === 'rescan-sessions') void loadSessions()
  else if (action === 'open-transcript' && target.dataset.sessionId !== undefined) handleOpenTranscript(target.dataset.sessionId, target.dataset.agentId ?? '')
  else if (action === 'back-to-sessions') handleBackToSessions()
  else if (action === 'open-search' && target.dataset.repoId) handleOpenSearch(target.dataset.repoId as RepoId)
  else if (action === 'search-back') handleBackFromSearch()
  else if (action === 'search-hit' && target.dataset.sessionId !== undefined) {
    handleOpenSearchHit(target.dataset.sessionId, target.dataset.agentId ?? '', Number(target.dataset.entryIndex ?? '0'), target.dataset.label ?? '')
  }
  else if (action === 'board-refresh') void handleBoardRefresh()
  else if (action === 'board-group-toggle') toggleGroupBy()
  else if (action === 'toggle-follow') toggleFollow()
  else if (action === 'jump-to-latest') jumpToLatest()
  else if (action === 'retry-transcript') resumeFollowing()
  else if (action === 'claim-open') openClaimDialog()
  else if (action?.startsWith('item-')) handleItemActionClick(target)
  else {
    const row = target.closest<HTMLElement>('.board-row')
    if (row?.dataset.url) window.open(row.dataset.url, '_blank')
  }
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
draw()
void refreshRepositories()
void initBoard()
if (app) initClaim(app)

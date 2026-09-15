import './index.css'
import './transcript.css'
import './board.css'
import './claim.css'
import type { AppInfo } from '../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { BoardSnapshot, GroupBy } from '../../shared/board/types'
import type { TranscriptTailFailureKind } from '../../shared/sessions/transcript'
import { render } from './repositories'
import type { RegistryBanner, RendererState } from './repositories'
import type { WorktreeSectionState } from './worktrees'
import { renderSessionsPicker, titleOf } from './sessions'
import type { SessionsPickerState } from './sessions'
import { applyTailDelta, clearTailBanner, jumpToLatest, renderTranscript, setFollowingIndicator, showTailBanner, showTruncatedNote } from './transcript'
import type { TailBannerKind, TranscriptViewState } from './transcript'
import { render as renderBoard } from './board/view'
import type { BoardViewState } from './board/view'
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
  | { readonly screen: 'transcript'; readonly sessionId: string; readonly agentId: string | null; readonly title: string }

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
let transcriptState: TranscriptViewState = { status: 'loading' }

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
  } else if (view.screen === 'transcript') {
    renderTranscript(reposContainer, transcriptState)
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

/** Following polls at a floor of one second — a local `fs.stat`, never a
 *  network call, so there is no pacing ladder here (`ENGINEERING §6`'s
 *  ladder is about the cockpit's GitHub tick): backing off would only add
 *  latency exactly when an idle agent wakes back up. */
const TAIL_INTERVAL_MS = 1000

/** The live follow session for whichever transcript is on screen — `null`
 *  outside the transcript view. Closed on every navigation away and
 *  replaced (never merged) on every re-open, so a superseded poll's
 *  response is dropped by the `tailId` check in `pollTranscriptTail`. */
interface TailSession {
  readonly tailId: string
  following: boolean
  timer: ReturnType<typeof setTimeout> | null
}

let tailSession: TailSession | null = null

function stopTailTimer(): void {
  if (tailSession?.timer != null) {
    clearTimeout(tailSession.timer)
    tailSession.timer = null
  }
}

function scheduleNextPoll(delayMs: number): void {
  if (tailSession === null || !tailSession.following || document.hidden) return
  const session = tailSession
  session.timer = setTimeout(() => void pollTranscriptTail(session.tailId), delayMs)
}

function closeTranscriptTail(): void {
  stopTailTimer()
  if (tailSession === null) return
  const { tailId } = tailSession
  tailSession = null
  window.port.transcriptTailClose({ tailId }).catch((error: unknown) => {
    console.error('Failed to close a transcript tail', error)
  })
}

/** `invalid-id`/`session-unresolved` cannot occur once a tail has already
 *  opened successfully once — the id never changes underneath a follow
 *  session — so they fold into `unreadable` defensively rather than adding
 *  a banner copy no real poll ever produces. */
function toBannerKind(kind: TranscriptTailFailureKind): TailBannerKind {
  if (kind === 'not-found' || kind === 'unreadable' || kind === 'too-large') return kind
  return 'unreadable'
}

async function openTranscriptTail(sessionId: string, agentId: string | null, title: string): Promise<void> {
  transcriptState = { status: 'loading' }
  draw()
  try {
    const opened = await window.port.transcriptTailOpen({ sessionId, agentId })
    if (!opened.ok) {
      transcriptState = { status: 'error', kind: opened.kind, message: opened.message, path: opened.path }
      tailSession = null
      draw()
      return
    }
    transcriptState = { status: 'ready', source: opened.source, entries: opened.entries, title }
    draw()
    tailSession = { tailId: opened.tailId, following: true, timer: null }
    scheduleNextPoll(TAIL_INTERVAL_MS)
  } catch (error) {
    console.error('Failed to open a transcript tail', error)
    tailSession = null
    transcriptState = { status: 'unreachable' }
    draw()
  }
}

/** `truncated`/`unknown-tail` both mean "the cursor no longer applies" —
 *  re-open from the start rather than reporting either as a banner, which
 *  an operator would misread as the agent having stopped. Only `truncated`
 *  leaves a trace: one dim note once the fresh render lands. */
async function reopenTranscriptTail(noteTruncation: boolean): Promise<void> {
  if (view.screen !== 'transcript') return
  await openTranscriptTail(view.sessionId, view.agentId, view.title)
  if (noteTruncation) showTruncatedNote()
}

function pauseFollowing(): void {
  if (tailSession === null) return
  tailSession.following = false
  stopTailTimer()
  setFollowingIndicator(false)
}

/** Shared by the follow toggle's resume and the error banner's `Retry` —
 *  both mean "poll again right now", which is also the manual-refresh
 *  affordance `Reload` used to be. */
function resumeFollowing(): void {
  if (tailSession === null) return
  tailSession.following = true
  setFollowingIndicator(true)
  clearTailBanner()
  void pollTranscriptTail(tailSession.tailId)
}

async function pollTranscriptTail(tailId: string): Promise<void> {
  if (tailSession === null || tailSession.tailId !== tailId) return // superseded by a navigation or a re-open
  try {
    const polled = await window.port.transcriptTailPoll({ tailId })
    if (tailSession === null || tailSession.tailId !== tailId) return

    if (!polled.ok) {
      if (polled.kind === 'unknown-tail') {
        await reopenTranscriptTail(false)
        return
      }
      if (polled.kind === 'truncated') {
        await reopenTranscriptTail(true)
        return
      }
      pauseFollowing()
      showTailBanner(toBannerKind(polled.kind), polled.message, polled.path)
      return
    }

    clearTailBanner()
    applyTailDelta({ appended: polled.appended, patched: polled.patched, source: polled.source })
    scheduleNextPoll(polled.hasMore ? 0 : TAIL_INTERVAL_MS)
  } catch (error) {
    console.error('Failed to poll a transcript tail', error)
    pauseFollowing()
    showTailBanner('unreachable', 'Lost contact with the main process.', null)
  }
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
    if (agent === undefined) return `agent-${agentId}`
    const stage = agent.stage ?? agent.agentType
    return agent.itemNumber !== null ? `${stage} #${agent.itemNumber}` : stage
  }
  const session = scan?.sessions.find((s) => s.sessionId === sessionId)
  return session !== undefined ? titleOf(session) : sessionId
}

function handleOpenTranscript(sessionId: string, agentId: string): void {
  const normalizedAgentId = agentId === '' ? null : agentId
  const title = titleFor(sessionId, normalizedAgentId)
  view = { screen: 'transcript', sessionId, agentId: normalizedAgentId, title }
  void openTranscriptTail(sessionId, normalizedAgentId, title)
}

function handleBackToSessions(): void {
  if (view.screen !== 'transcript') return
  const { sessionId } = view
  closeTranscriptTail()
  // The picker's own state is still in memory from the last scan — reopen
  // it without a fresh round trip; `rescan-sessions` covers a deliberate
  // refresh.
  const repoId = sessionsState.status === 'ready' ? (sessionsState.scan.sessions.find((s) => s.sessionId === sessionId)?.repoId ?? null) : null
  view = repoId !== null ? { screen: 'sessions', repoId, repoLabel: repoLabelFor(repoId) } : { screen: 'repos' }
  draw()
}

function handleToggleFollow(): void {
  if (tailSession === null) return
  if (tailSession.following) pauseFollowing()
  else resumeFollowing()
}

function handleRetryTranscript(): void {
  resumeFollowing()
}

document.addEventListener('visibilitychange', () => {
  if (view.screen !== 'transcript' || tailSession === null) return
  if (document.hidden) {
    stopTailTimer()
  } else if (tailSession.following) {
    void pollTranscriptTail(tailSession.tailId) // poll once immediately on return
  }
})

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
  else if (action === 'board-refresh') void handleBoardRefresh()
  else if (action === 'board-group-toggle') toggleGroupBy()
  else if (action === 'toggle-follow') handleToggleFollow()
  else if (action === 'jump-to-latest') jumpToLatest()
  else if (action === 'retry-transcript') handleRetryTranscript()
  else if (action === 'claim-open') openClaimDialog()
  else {
    const row = target.closest<HTMLElement>('.board-row')
    if (row?.dataset.url) window.open(row.dataset.url, '_blank')
  }
})

draw()
void refreshRepositories()
void initBoard()
if (app) initClaim(app)

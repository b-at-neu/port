import './index.css'
import './transcript.css'
import type { AppInfo } from '../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import { render } from './repositories'
import type { RegistryBanner, RendererState } from './repositories'
import type { WorktreeSectionState } from './worktrees'
import { renderSessionsPicker } from './sessions'
import type { SessionsPickerState } from './sessions'
import { renderTranscript } from './transcript'
import type { TranscriptViewState } from './transcript'

const app = document.querySelector<HTMLDivElement>('#app')

/** Which screen is on top — `repos` is the always-available base; `sessions`
 *  and `transcript` are #83's picker and viewer, reached only from a ready
 *  repository card and never bookmarked (no router, no URL state). */
type View =
  | { readonly screen: 'repos' }
  | { readonly screen: 'sessions'; readonly repoId: RepoId; readonly repoLabel: string }
  | { readonly screen: 'transcript'; readonly sessionId: string; readonly agentId: string | null; readonly title: string }

let state: RendererState = { status: 'loading', repositories: [] }
let worktreeSections = new Map<RepoId, WorktreeSectionState>()
let view: View = { screen: 'repos' }
let sessionsState: SessionsPickerState = { status: 'loading' }
let transcriptState: TranscriptViewState = { status: 'loading' }

function draw(): void {
  if (!app) return
  if (view.screen === 'repos') {
    render(app, { ...state, worktreeSections })
  } else if (view.screen === 'sessions') {
    renderSessionsPicker(app, view.repoId, view.repoLabel, sessionsState)
  } else {
    renderTranscript(app, transcriptState)
  }
}

function bannerFor(kind: string): RegistryBanner['reason'] {
  if (kind === 'registry-malformed') return 'malformed'
  if (kind === 'registry-unsupported-version') return 'unsupported-version'
  return 'unreadable'
}

async function refresh(): Promise<void> {
  state = { ...state, status: 'loading' }
  draw()
  try {
    const [info, result] = await Promise.all([window.port.appInfo(), window.port.reposList()])
    applyListResult(info, result)
  } catch (error) {
    console.error('Failed to reach the main process', error)
    state = { status: 'error', repositories: [] }
    draw()
  }
}

function applyListResult(appInfo: AppInfo, result: Awaited<ReturnType<typeof window.port.reposList>>): void {
  if (!result.ok) {
    state = { status: 'ready', repositories: [], appInfo, registryBanner: { path: 'registry.json', reason: bannerFor(result.kind) } }
    draw()
    return
  }
  state = { status: 'ready', repositories: result.repositories, appInfo }
  draw()
}

function highlight(id: RepoId, repositories: readonly RepositoryEntry[], notice: string): void {
  state = { ...state, status: 'ready', repositories, highlighted: id, notice }
  draw()
  setTimeout(() => {
    state = { ...state, highlighted: undefined, notice: undefined }
    draw()
  }, 3000)
}

async function handleAdd(): Promise<void> {
  state = { ...state, status: 'loading' }
  draw()
  try {
    const result = await window.port.reposAdd()
    if (!result.ok) {
      state = { ...state, status: 'ready', registryBanner: { path: 'registry.json', reason: bannerFor(result.kind) } }
      draw()
      return
    }
    if (result.outcome === 'cancelled') {
      state = { ...state, status: 'ready' }
      draw()
      return
    }
    if (result.outcome === 'already-registered') {
      highlight(result.existing, result.repositories, 'Already added.')
      return
    }
    state = { ...state, status: 'ready', repositories: result.repositories, registryBanner: undefined }
    draw()
  } catch (error) {
    console.error('Failed to add a repository', error)
    state = { status: 'error', repositories: [] }
    draw()
  }
}

async function handleRemove(id: RepoId): Promise<void> {
  state = { ...state, status: 'loading' }
  draw()
  try {
    const result = await window.port.reposRemove({ id })
    if (!result.ok) {
      state = { ...state, status: 'ready' }
      draw()
      return
    }
    state = { ...state, status: 'ready', repositories: result.repositories }
    draw()
  } catch (error) {
    console.error('Failed to remove a repository', error)
    state = { status: 'error', repositories: [] }
    draw()
  }
}

/** Holds the per-repository inspection state in its own `Map` (never
 *  blanking one card when another refreshes) and never polls — a
 *  `worktrees:report` round trip runs only when the operator asks
 *  (Decision 5). */
async function handleInspectWorktrees(id: RepoId): Promise<void> {
  worktreeSections = new Map(worktreeSections).set(id, { status: 'loading' })
  draw()
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

function titleFor(sessionId: string, agentId: string | null): string {
  if (agentId === null) return sessionId
  return `agent-${agentId}`
}

async function loadTranscript(sessionId: string, agentId: string | null): Promise<void> {
  transcriptState = { status: 'loading' }
  draw()
  try {
    const read = await window.port.transcriptRead({ sessionId, agentId })
    transcriptState = read.ok ? { status: 'ready', read, title: titleFor(sessionId, agentId) } : { status: 'error', kind: read.kind, message: read.message, path: read.path }
  } catch (error) {
    console.error('Failed to read a transcript', error)
    transcriptState = { status: 'unreachable' }
  }
  draw()
}

function handleOpenTranscript(sessionId: string, agentId: string): void {
  const normalizedAgentId = agentId === '' ? null : agentId
  view = { screen: 'transcript', sessionId, agentId: normalizedAgentId, title: titleFor(sessionId, normalizedAgentId) }
  void loadTranscript(sessionId, normalizedAgentId)
}

function handleBackToSessions(): void {
  if (view.screen !== 'transcript') return
  const { sessionId } = view
  // The picker's own state is still in memory from the last scan — reopen
  // it without a fresh round trip; `rescan-sessions` covers a deliberate
  // refresh.
  const repoId = sessionsState.status === 'ready' ? (sessionsState.scan.sessions.find((s) => s.sessionId === sessionId)?.repoId ?? null) : null
  view = repoId !== null ? { screen: 'sessions', repoId, repoLabel: repoLabelFor(repoId) } : { screen: 'repos' }
  draw()
}

function handleReloadTranscript(): void {
  if (view.screen !== 'transcript') return
  void loadTranscript(view.sessionId, view.agentId)
}

app?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const action = target.dataset.action
  if (action === 'add') void handleAdd()
  else if (action === 'rescan') void refresh()
  else if (action === 'remove' && target.dataset.repoId) void handleRemove(target.dataset.repoId as RepoId)
  else if (action === 'inspect-worktrees' && target.dataset.repoId) void handleInspectWorktrees(target.dataset.repoId as RepoId)
  else if (action === 'transcripts' && target.dataset.repoId) handleOpenSessions(target.dataset.repoId as RepoId)
  else if (action === 'back-to-repos') handleBackToRepos()
  else if (action === 'rescan-sessions') void loadSessions()
  else if (action === 'open-transcript' && target.dataset.sessionId !== undefined) handleOpenTranscript(target.dataset.sessionId, target.dataset.agentId ?? '')
  else if (action === 'back-to-sessions') handleBackToSessions()
  else if (action === 'reload-transcript') handleReloadTranscript()
})

void refresh()

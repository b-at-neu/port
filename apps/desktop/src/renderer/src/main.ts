import './index.css'
import type { AppInfo } from '../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import { render } from './repositories'
import type { RegistryBanner, RendererState } from './repositories'
import type { WorktreeSectionState } from './worktrees'

const app = document.querySelector<HTMLDivElement>('#app')

let state: RendererState = { status: 'loading', repositories: [] }
let worktreeSections = new Map<RepoId, WorktreeSectionState>()

function draw(): void {
  if (!app) return
  render(app, { ...state, worktreeSections })
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

app?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const action = target.dataset.action
  if (action === 'add') void handleAdd()
  else if (action === 'rescan') void refresh()
  else if (action === 'remove' && target.dataset.repoId) void handleRemove(target.dataset.repoId as RepoId)
  else if (action === 'inspect-worktrees' && target.dataset.repoId) void handleInspectWorktrees(target.dataset.repoId as RepoId)
})

void refresh()

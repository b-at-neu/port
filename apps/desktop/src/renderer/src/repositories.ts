// The repositories screen: a `render(state)` over a state union, building
// the header, empty state, cards, banners, diagnostics, and footer. Every
// node is built with `document.createElement`/`textContent`, never
// `innerHTML` with an interpolated config value — a repository's config
// arrives verbatim from a file on disk. #80 answered the UI framework
// question this header used to defer: none, deliberately — see
// CONTRIBUTING.md → "Working on the desktop app". This screen keeps its own
// current behaviour, unchanged, beside the new Board view.
import type { AppInfo } from '../../shared/ipc'
import type { RepoId, RepositoryEntry, RepoProblem } from '../../shared/repos'
import { buildWorktreesSection } from './worktrees'
import type { WorktreeSectionState } from './worktrees'
import { diagnosticCopy, overrideLineCopy, problemCopy, registryBannerCopy, summaryParts } from './repositories/copy'
import type { RegistryBanner } from './repositories/copy'

export type { RegistryBanner, RegistryErrorReason } from './repositories/copy'
export { diagnosticCopy, overrideLineCopy, problemCopy, summaryParts }

export interface RendererState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly repositories: readonly RepositoryEntry[]
  readonly registryBanner?: RegistryBanner
  readonly notice?: string
  readonly highlighted?: RepoId
  readonly appInfo?: AppInfo
  /** One inspection state per ready repository (#86) — a `Map` so
   *  inspecting one card's worktrees never blanks another's, and a repo
   *  with no entry here renders as `idle`. */
  readonly worktreeSections?: ReadonlyMap<RepoId, WorktreeSectionState>
}

const IDLE_WORKTREE_SECTION: WorktreeSectionState = { status: 'idle' }

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function buildReadyCard(entry: Extract<RepositoryEntry, { status: 'ready' }>, highlighted: boolean, worktreeSection: WorktreeSectionState): HTMLElement {
  const card = document.createElement('div')
  card.className = highlighted ? 'repo-card repo-card--highlighted' : 'repo-card'
  card.dataset.repoId = entry.id

  const titleRow = document.createElement('div')
  titleRow.className = 'repo-card__title-row'
  titleRow.appendChild(text('span', 'repo-card__title', entry.config.repo))
  const newSessionButton = document.createElement('button')
  newSessionButton.className = 'repo-card__new-session'
  newSessionButton.textContent = 'New session'
  newSessionButton.dataset.action = 'session-start'
  newSessionButton.dataset.repoId = entry.id
  newSessionButton.dataset.repoLabel = entry.config.repo
  titleRow.appendChild(newSessionButton)
  const transcriptsButton = document.createElement('button')
  transcriptsButton.className = 'repo-card__transcripts'
  transcriptsButton.textContent = 'Transcripts'
  transcriptsButton.dataset.action = 'transcripts'
  transcriptsButton.dataset.repoId = entry.id
  titleRow.appendChild(transcriptsButton)
  const removeButton = document.createElement('button')
  removeButton.className = 'repo-card__remove'
  removeButton.textContent = 'Remove'
  removeButton.dataset.action = 'remove'
  removeButton.dataset.repoId = entry.id
  titleRow.appendChild(removeButton)
  card.appendChild(titleRow)

  card.appendChild(text('div', 'repo-card__path', entry.path))

  card.appendChild(text('div', 'repo-card__summary', summaryParts(entry.config).join(' · ')))

  if (entry.config.overrides.length > 0) {
    const list = document.createElement('ul')
    list.className = 'repo-card__overrides'
    for (const override of entry.config.overrides) {
      list.appendChild(text('li', 'repo-card__override', overrideLineCopy(override)))
    }
    card.appendChild(list)
  }

  if (entry.diagnostics.length > 0) {
    const list = document.createElement('ul')
    list.className = 'repo-card__diagnostics'
    for (const diagnostic of entry.diagnostics) {
      list.appendChild(text('li', 'repo-card__diagnostic', diagnosticCopy(diagnostic)))
    }
    card.appendChild(list)
  }

  card.appendChild(buildWorktreesSection(entry.config.commands.worktrees, entry.id, worktreeSection))

  return card
}

function buildProblemCard(entry: Extract<RepositoryEntry, { problem: RepoProblem }>, highlighted: boolean): HTMLElement {
  const card = document.createElement('div')
  card.className = highlighted ? 'repo-card repo-card--highlighted' : 'repo-card'
  card.dataset.repoId = entry.id

  const titleRow = document.createElement('div')
  titleRow.className = 'repo-card__title-row'
  titleRow.appendChild(text('span', 'repo-card__title', entry.displayName))
  const removeButton = document.createElement('button')
  removeButton.className = 'repo-card__remove'
  removeButton.textContent = 'Remove'
  removeButton.dataset.action = 'remove'
  removeButton.dataset.repoId = entry.id
  titleRow.appendChild(removeButton)
  card.appendChild(titleRow)

  card.appendChild(text('div', 'repo-card__path', entry.path))
  card.appendChild(text('div', 'repo-card__banner', problemCopy(entry.problem)))

  if (entry.diagnostics.length > 0) {
    const list = document.createElement('ul')
    list.className = 'repo-card__diagnostics'
    for (const diagnostic of entry.diagnostics) {
      list.appendChild(text('li', 'repo-card__diagnostic', diagnosticCopy(diagnostic)))
    }
    card.appendChild(list)
  }

  return card
}

function buildCard(entry: RepositoryEntry, highlighted: boolean, worktreeSection: WorktreeSectionState): HTMLElement {
  return 'config' in entry ? buildReadyCard(entry, highlighted, worktreeSection) : buildProblemCard(entry, highlighted)
}

function buildHeader(state: RendererState): HTMLElement {
  const header = document.createElement('div')
  header.className = 'repos-header'

  const title = document.createElement('h1')
  title.textContent = state.notice ?? (state.status === 'loading' ? 'Checking repositories…' : 'Port')
  header.appendChild(title)

  const actions = document.createElement('div')
  actions.className = 'repos-header__actions'

  const addButton = document.createElement('button')
  addButton.textContent = 'Add repository…'
  addButton.dataset.action = 'add'
  addButton.disabled = state.status === 'loading'
  actions.appendChild(addButton)

  const rescanButton = document.createElement('button')
  rescanButton.textContent = 'Rescan'
  rescanButton.dataset.action = 'rescan'
  rescanButton.disabled = state.status === 'loading'
  actions.appendChild(rescanButton)

  header.appendChild(actions)
  return header
}

function buildFooter(appInfo: AppInfo | undefined): HTMLElement {
  const footer = document.createElement('div')
  footer.className = 'repos-footer'
  if (appInfo) {
    footer.appendChild(text('p', 'versions', `Electron ${appInfo.electron} · Chromium ${appInfo.chromium} · Node ${appInfo.node}`))
    footer.appendChild(text('p', 'app-version', `port ${appInfo.app}`))
  }
  return footer
}

export function render(container: HTMLElement, state: RendererState): void {
  container.textContent = ''
  container.appendChild(buildHeader(state))

  const list = document.createElement('div')
  list.className = 'repos-list'

  if (state.status === 'error') {
    list.appendChild(text('p', 'error', 'Could not reach the main process.'))
  } else if (state.registryBanner) {
    list.appendChild(text('p', 'error', registryBannerCopy(state.registryBanner)))
  } else if (state.repositories.length === 0 && state.status === 'ready') {
    const empty = document.createElement('div')
    empty.className = 'repos-empty'
    empty.appendChild(text('p', 'repos-empty__title', 'No repositories yet.'))
    empty.appendChild(text('p', 'repos-empty__hint', 'Add a port-managed repository to see its pipeline.'))
    list.appendChild(empty)
  } else {
    for (const entry of state.repositories) {
      const worktreeSection = state.worktreeSections?.get(entry.id) ?? IDLE_WORKTREE_SECTION
      list.appendChild(buildCard(entry, entry.id === state.highlighted, worktreeSection))
    }
  }

  container.appendChild(list)
  container.appendChild(buildFooter(state.appInfo))
}

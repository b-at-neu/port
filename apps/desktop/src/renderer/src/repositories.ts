// The repositories screen: a `render(state)` over a state union, building
// the header, empty state, cards, banners, diagnostics, and footer. Every
// node is built with `document.createElement`/`textContent`, never
// `innerHTML` with an interpolated config value — a repository's config
// arrives verbatim from a file on disk. #80 picks a UI framework and this
// ~200-line screen is what it replaces; until then it stays plain DOM.
import type { AppInfo } from '../../shared/ipc'
import type { RepoDiagnostic, RepoId, RepoProblem, RepositoryEntry, ResolvedRepoConfig } from '../../shared/repos'
import { buildWorktreesSection } from './worktrees'
import type { WorktreeSectionState } from './worktrees'

export type RegistryErrorReason = 'unreadable' | 'malformed' | 'unsupported-version'

export interface RegistryBanner {
  readonly path: string
  readonly reason: RegistryErrorReason
}

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

const MODULE_LABELS: { readonly [K in keyof ResolvedRepoConfig['modules']]: string } = {
  approvalGate: 'approval gate',
  release: 'release',
  scope: 'scope',
}

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function problemCopy(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return "That folder is gone. It may have moved, or be on a drive that isn't mounted."
    case 'not-a-git-repository':
      return "Not a git repository. Pick the repository's root folder."
    case 'not-port-managed':
      return problem.carriedBy.length > 0
        ? `Not port-managed on ${problem.currentBranch}. The harness is on ${problem.carriedBy.join(', ')} — check one of those out and rescan.`
        : "Not port-managed. There's no .claude/port.config.json on any branch here. Run /port:init in this repository to adopt the pipeline."
    case 'config-malformed':
      return `.claude/port.config.json isn't valid JSON — ${problem.message}.`
    case 'config-invalid':
      return `.claude/port.config.json has no usable repo: ${problem.violations[0]?.message ?? 'invalid'}. Every GitHub query is scoped to it, so nothing can be read until it's set.`
    case 'config-unreadable':
      return `Can't read .claude/port.config.json — ${problem.message}.`
  }
}

function diagnosticCopy(diagnostic: RepoDiagnostic): string {
  switch (diagnostic.kind) {
    case 'off-integration-branch':
      return `On ${diagnostic.branch}, not ${diagnostic.integration}. Dispatched agents work from ${diagnostic.integration}, so what's on disk here isn't what they see.`
    case 'detached-head':
      return `Detached at ${diagnostic.sha}.`
    case 'permissions-missing':
      return 'No .claude/settings.json on this branch — dispatched agents would auto-deny every command.'
    case 'permissions-empty':
      return 'No permissions.allow on this branch — dispatched agents would auto-deny every command.'
    case 'schema-violations': {
      const first = diagnostic.violations[0]
      return `Config doesn't match the schema in ${diagnostic.violations.length} place(s): ${first ? `${first.path} ${first.message}` : ''}. Reading it anyway, with defaults for those fields.`
    }
    case 'git-unavailable':
      return "Couldn't run git, so branch checks were skipped."
  }
}

function registryBannerCopy(banner: RegistryBanner): string {
  const reason =
    banner.reason === 'unreadable'
      ? "couldn't be read"
      : banner.reason === 'malformed'
        ? "isn't valid JSON"
        : 'was written by a newer version of Port'
  return `Your repository list at ${banner.path} ${reason}. Nothing was changed — fix or delete that file and rescan.`
}

function moduleSummary(modules: ResolvedRepoConfig['modules']): string {
  const keys = Object.keys(MODULE_LABELS) as (keyof ResolvedRepoConfig['modules'])[]
  return keys
    .filter((key) => modules[key])
    .map((key) => MODULE_LABELS[key])
    .join(', ')
}

function buildReadyCard(entry: Extract<RepositoryEntry, { status: 'ready' }>, highlighted: boolean, worktreeSection: WorktreeSectionState): HTMLElement {
  const card = document.createElement('div')
  card.className = highlighted ? 'repo-card repo-card--highlighted' : 'repo-card'
  card.dataset.repoId = entry.id

  const titleRow = document.createElement('div')
  titleRow.className = 'repo-card__title-row'
  titleRow.appendChild(text('span', 'repo-card__title', entry.config.repo))
  const removeButton = document.createElement('button')
  removeButton.className = 'repo-card__remove'
  removeButton.textContent = 'Remove'
  removeButton.dataset.action = 'remove'
  removeButton.dataset.repoId = entry.id
  titleRow.appendChild(removeButton)
  card.appendChild(titleRow)

  card.appendChild(text('div', 'repo-card__path', entry.path))

  const labelCount = entry.config.vocabulary.labels.length
  const parts = [`${entry.config.branches.integration} → ${entry.config.branches.production}`, `${labelCount} pipeline labels`, moduleSummary(entry.config.modules)].filter((part) => part !== '')
  card.appendChild(text('div', 'repo-card__summary', parts.join(' · ')))

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

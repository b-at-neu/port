// The board screen's shell (#80) — header, freshness strip, group toggle,
// Refresh button, and the group sections. Plain DOM: a stable list
// container whose `scrollTop` survives a rebuild, and a rebuild skipped
// entirely when `boardSignature` is unchanged (Decision 1) — the two things
// a UI framework would otherwise buy here, at no dependency cost.
import { boardSignature, projectBoard } from '../../../shared/board/project'
import type { BoardSnapshot, GroupBy } from '../../../shared/board/types'
import type { RepositoryState } from '../../../shared/state/types'
import type { RepoId } from '../../../shared/repos'
import { notReadyCopy, rateLimitCopy, sourceHealthCopy } from './copy'
import { buildRow } from './rows'

export interface BoardViewState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly snapshot: BoardSnapshot | null
  readonly groupBy: GroupBy
  readonly refreshing: boolean
  readonly now: Date
}

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function buildHeader(state: BoardViewState): HTMLElement {
  const header = document.createElement('div')
  header.className = 'board-header'

  const top = document.createElement('div')
  top.className = 'board-header__top'
  top.appendChild(text('h1', 'board-header__title', 'Pipeline board'))

  const actions = document.createElement('div')
  actions.className = 'board-header__actions'

  const groupToggle = document.createElement('button')
  groupToggle.className = 'board-header__toggle'
  groupToggle.dataset.action = 'board-group-toggle'
  groupToggle.textContent = state.groupBy === 'stage' ? 'Group: Stage' : 'Group: Repo'
  actions.appendChild(groupToggle)

  const refreshButton = document.createElement('button')
  refreshButton.className = 'board-header__refresh'
  refreshButton.dataset.action = 'board-refresh'
  refreshButton.textContent = 'Refresh'
  refreshButton.disabled = state.refreshing
  actions.appendChild(refreshButton)

  top.appendChild(actions)
  header.appendChild(top)

  const firstRepoHealth = state.snapshot?.health[0]
  if (state.snapshot !== null && firstRepoHealth !== undefined) {
    const strip = document.createElement('div')
    strip.className = 'board-header__freshness'
    const parts = (['github', 'sessions', 'worktrees', 'denials'] as const).map((kind) => sourceHealthCopy(kind, firstRepoHealth[kind], state.now))
    const rateLimit = state.snapshot.state.repositories.find((r): r is Extract<RepositoryState, { ok: true }> => r.ok)?.rateLimit ?? null
    const rateLimitText = rateLimit !== null ? rateLimitCopy(null, rateLimit.remaining, rateLimit.resetAt) : null
    strip.textContent = [...parts, rateLimitText].filter((p): p is string => p !== null).join(' · ')
    header.appendChild(strip)
  }

  return header
}

function buildGroupSection(name: string, count: number, rows: readonly ReturnType<typeof buildRow>[], denialBurst: string | null): HTMLElement {
  const section = document.createElement('div')
  section.className = 'board-group'
  const heading = `${name} · ${String(count)}`
  section.appendChild(text('div', 'board-group__heading', denialBurst !== null ? `${heading} · ${denialBurst}` : heading))
  const rowsContainer = document.createElement('div')
  rowsContainer.className = 'board-group__rows'
  for (const row of rows) rowsContainer.appendChild(row)
  section.appendChild(rowsContainer)
  return section
}

function buildNotReadySection(states: readonly Extract<RepositoryState, { readonly ok: false }>[]): HTMLElement | null {
  if (states.length === 0) return null
  const section = document.createElement('div')
  section.className = 'board-not-ready'
  section.appendChild(text('div', 'board-not-ready__heading', 'Not reading'))
  for (const state of states) {
    const line = document.createElement('div')
    line.className = 'board-not-ready__line'
    const name = 'repo' in state && state.repo !== undefined ? state.repo : state.displayName
    line.textContent = `${name} — ${notReadyCopy(state)}`
    section.appendChild(line)
  }
  return section
}

function buildList(state: BoardViewState): HTMLElement {
  const list = document.createElement('div')
  list.className = 'board-list'

  if (state.snapshot === null) {
    list.appendChild(text('p', 'board-empty', 'Reading repositories…'))
    return list
  }

  const projection = projectBoard({ snapshot: state.snapshot, groupBy: state.groupBy, now: state.now })
  list.dataset.signature = projection.signature

  const notReadySection = buildNotReadySection(projection.notReady)
  if (notReadySection !== null) list.appendChild(notReadySection)

  if (projection.groups.length === 0 && projection.notReady.length === 0) {
    if (state.snapshot.state.repositories.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'board-empty'
      empty.appendChild(text('p', 'board-empty__title', 'No repositories yet.'))
      empty.appendChild(text('p', 'board-empty__hint', 'Add a port-managed repository to see its pipeline.'))
      list.appendChild(empty)
    } else {
      list.appendChild(text('p', 'board-empty', 'Nothing in the pipeline.'))
    }
    return list
  }

  const summaryByRepo = new Map(projection.repositorySummaries.map((summary) => [summary.repoId, summary]))
  for (const group of projection.groups) {
    // Group identity is the label key or the RepoId — the denial badge only
    // ever applies to a repo-grouped section, since a stage group can span
    // several repositories (#80 Decision 7).
    const denialBurst = state.groupBy === 'repo' ? (summaryByRepo.get(group.key as RepoId)?.denialBurst ?? null) : null
    list.appendChild(buildGroupSection(group.name, group.rows.length, group.rows.map(buildRow), denialBurst))
  }

  return list
}

export function render(container: HTMLElement, state: BoardViewState): void {
  if (state.status === 'error') {
    container.textContent = ''
    container.appendChild(text('p', 'error', 'Could not reach the main process.'))
    return
  }

  const existingList = container.querySelector<HTMLElement>('.board-list')
  const projection = state.snapshot !== null ? projectBoard({ snapshot: state.snapshot, groupBy: state.groupBy, now: state.now }) : null
  const unchanged = existingList !== null && projection !== null && existingList.dataset.signature === projection.signature

  const header = buildHeader(state)
  const existingHeader = container.querySelector('.board-header')
  if (existingHeader) existingHeader.replaceWith(header)
  else container.insertBefore(header, container.firstChild)

  if (unchanged) return

  const previousScrollTop = existingList?.scrollTop ?? 0
  const list = buildList(state)
  list.scrollTop = previousScrollTop
  if (existingList) existingList.replaceWith(list)
  else container.appendChild(list)
}

export { boardSignature }

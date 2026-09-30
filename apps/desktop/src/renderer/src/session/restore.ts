// #103: the restore banner — offered once at boot when `session:restore:list`
// returns entries, shown at the top of the rail. `renderRestore()` rebuilds
// fresh on every call; the controller (`session/controller.ts`) owns the
// review/error state this renders and the click handlers below.
import type { RepoId } from '../../../shared/repos'
import type { RestorableSession } from '../../../shared/hosting/types'
import { RESTORE_DISMISS, RESTORE_FORGET, RESTORE_RESUME_ALL, RESTORE_RESUME_ONE, RESTORE_REVIEW, restoreBannerLine, restoreOpenedLine, restoreUnavailableLine } from './rail-copy'

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(label: string, action: string, className: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.textContent = label
  node.dataset.action = action
  return node
}

export interface RestoreBannerState {
  readonly entries: readonly RestorableSession[]
  readonly reviewing: boolean
  /** Set after **Resume all** stops at the limit, or a single resume fails —
   *  shown inline, never a second banner. */
  readonly notice: string | null
  readonly repoLabelFor: (repoId: RepoId) => string
  readonly now: Date
}

function buildReviewRow(entry: RestorableSession, state: RestoreBannerState): HTMLElement {
  const row = el('div', 'session-restore__row')
  const label = entry.title ?? `Resumed session ${entry.origin.from.slice(0, 8)}`
  row.appendChild(el('span', 'session-restore__row-label', `${state.repoLabelFor(entry.repoId)} · ${label}`))
  row.appendChild(el('span', 'session-restore__row-meta', restoreOpenedLine(entry.startedAt, state.now)))

  if (!entry.availability.ok) {
    row.appendChild(el('p', 'session-restore__row-unavailable', restoreUnavailableLine(entry.availability.reason)))
  } else {
    const resume = button(RESTORE_RESUME_ONE, 'session-restore-one', 'session-restore__row-button')
    resume.dataset.restoreId = entry.restoreId
    row.appendChild(resume)
  }

  const forget = button(RESTORE_FORGET, 'session-restore-forget', 'session-restore__row-button')
  forget.dataset.restoreId = entry.restoreId
  row.appendChild(forget)

  return row
}

export function renderRestore(host: HTMLElement, state: RestoreBannerState): void {
  host.textContent = ''
  if (state.entries.length === 0) return

  const banner = el('div', 'session-restore')
  banner.setAttribute('aria-live', 'polite')
  banner.appendChild(el('p', 'session-restore__line', restoreBannerLine(state.entries.length)))

  if (state.notice !== null) banner.appendChild(el('p', 'session-restore__notice', state.notice))

  const actions = el('div', 'session-restore__actions')
  actions.appendChild(button(RESTORE_RESUME_ALL, 'session-restore-all', 'session-restore__button'))
  actions.appendChild(button(RESTORE_REVIEW, 'session-restore-review', 'session-restore__button'))
  actions.appendChild(button(RESTORE_DISMISS, 'session-restore-dismiss', 'session-restore__button'))
  banner.appendChild(actions)

  if (state.reviewing) {
    const rows = el('div', 'session-restore__rows')
    for (const entry of state.entries) rows.appendChild(buildReviewRow(entry, state))
    banner.appendChild(rows)
  }

  host.appendChild(banner)
}

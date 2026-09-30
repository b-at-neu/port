// #103: the session rail's DOM — header (title, capacity line, limit
// stepper, new-session picker), the usage notice, and the rows. Built fresh
// on every `renderRail()` call: nothing here holds a cursor or a draft the
// way the composer does, so a full rebuild is simplest. Every node is
// `createElement`/`textContent` only.
import type { HostedSessionSnapshot, SessionKey } from '../../../shared/hosting/types'
import type { RepoId } from '../../../shared/repos'
import { sessionDisplayLabel, startedClock } from '../../../shared/hosting/label'
import { capacityLine, openCount, rowsFor, rowStatus, usageNotice } from './rail-model'
import { DISMISS_BUTTON, LIMIT_STEPPER_TITLE, NEW_SESSION_NO_REPO, NEW_SESSION_START, RAIL_EMPTY_HINT, RAIL_EMPTY_TITLE, RAIL_TITLE, rowMeta, usageNoticeLines } from './rail-copy'

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

export interface RailProps {
  readonly snapshots: readonly HostedSessionSnapshot[]
  readonly selectedKey: SessionKey | null
  readonly limit: number
  readonly ceiling: number
  readonly repoLabelFor: (repoId: RepoId) => string
  readonly readyRepos: readonly { readonly id: RepoId; readonly label: string }[]
  readonly newSessionRepoId: RepoId | null
  /** Set only after a failed `session:capacity:set` round trip. */
  readonly capacityError: string | null
  readonly now: Date
}

function buildHeader(props: RailProps): HTMLElement {
  const header = el('div', 'session-rail__header')
  header.appendChild(el('h2', 'session-rail__title', RAIL_TITLE))

  const open = openCount(props.snapshots)
  header.appendChild(el('p', 'session-rail__capacity', capacityLine(open, props.limit)))
  if (props.capacityError !== null) header.appendChild(el('p', 'session-rail__capacity-error', props.capacityError))

  const stepper = el('div', 'session-rail__stepper')
  stepper.title = LIMIT_STEPPER_TITLE
  const minus = button('−', 'session-limit-decrement', 'session-rail__stepper-button')
  minus.disabled = props.limit <= 1
  stepper.appendChild(minus)
  stepper.appendChild(el('span', 'session-rail__stepper-value', String(props.limit)))
  const plus = button('+', 'session-limit-increment', 'session-rail__stepper-button')
  plus.disabled = props.limit >= props.ceiling
  stepper.appendChild(plus)
  header.appendChild(stepper)

  const picker = el('div', 'session-rail__picker')
  const select = document.createElement('select')
  select.className = 'session-rail__picker-select'
  select.dataset.field = 'session-new-repo'
  select.disabled = props.readyRepos.length === 0
  for (const repo of props.readyRepos) {
    const option = document.createElement('option')
    option.value = repo.id
    option.textContent = repo.label
    option.selected = repo.id === props.newSessionRepoId
    select.appendChild(option)
  }
  picker.appendChild(select)

  const atCapacity = open >= props.limit
  const start = button(NEW_SESSION_START, 'session-new-start', 'session-rail__picker-start')
  start.disabled = props.readyRepos.length === 0 || atCapacity
  start.title = props.readyRepos.length === 0 ? NEW_SESSION_NO_REPO : atCapacity ? capacityLine(open, props.limit) : ''
  picker.appendChild(start)
  header.appendChild(picker)

  return header
}

function buildUsageNotice(props: RailProps): HTMLElement | null {
  const notice = usageNotice(props.snapshots, props.now)
  if (notice === null) return null
  const lines = usageNoticeLines(notice, props.now)
  const host = el('div', `session-rail__usage session-rail__usage--${notice.status}`)
  host.setAttribute('role', 'status')
  host.appendChild(el('p', 'session-rail__usage-main', lines.main))
  host.appendChild(el('p', 'session-rail__usage-sub', lines.sub))
  return host
}

function buildRow(snapshot: HostedSessionSnapshot, props: RailProps): HTMLElement {
  const status = rowStatus(snapshot)
  const row = document.createElement('button')
  row.className = 'session-rail__row'
  row.dataset.action = 'session-select'
  row.dataset.sessionKey = snapshot.sessionKey
  row.title = snapshot.repoId
  if (snapshot.sessionKey === props.selectedKey) row.setAttribute('aria-current', 'true')

  row.appendChild(el('span', 'session-rail__row-status', `${status.glyph} ${status.word}`))
  row.appendChild(el('span', 'session-rail__row-label', sessionDisplayLabel(snapshot, props.repoLabelFor(snapshot.repoId))))
  row.appendChild(el('span', 'session-rail__row-meta', rowMeta(startedClock(snapshot.startedAt, props.now), snapshot.pendingPermissions.length)))

  if (snapshot.phase === 'ended') {
    const dismiss = button(DISMISS_BUTTON, 'session-dismiss', 'session-rail__dismiss')
    dismiss.dataset.sessionKey = snapshot.sessionKey
    row.appendChild(dismiss)
  }

  return row
}

export function renderRail(host: HTMLElement, props: RailProps): void {
  host.textContent = ''
  host.appendChild(buildHeader(props))

  const notice = buildUsageNotice(props)
  if (notice !== null) host.appendChild(notice)

  const rows = rowsFor(props.snapshots)
  if (rows.length === 0) {
    const empty = el('div', 'session-rail__empty')
    empty.appendChild(el('p', 'session-rail__empty-title', RAIL_EMPTY_TITLE))
    empty.appendChild(el('p', 'session-rail__empty-hint', RAIL_EMPTY_HINT))
    host.appendChild(empty)
    return
  }

  const list = el('div', 'session-rail__rows')
  for (const snapshot of rows) list.appendChild(buildRow(snapshot, props))
  host.appendChild(list)
}

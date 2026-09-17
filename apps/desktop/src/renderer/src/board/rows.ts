// One board item row and its sub-line (#80). `document.createElement`/
// `textContent` only — a title, an assignee, or an agent description arrives
// verbatim from GitHub or a local transcript, never through `innerHTML`.
import type { BoardItemRow } from '../../../shared/board/types'
import type { AttachedAgent, AttachedSession } from '../../../shared/state/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import { OPERATOR_ACTIONS } from '../../../shared/actions/types'
import type { ActionAvailability, OperatorAction } from '../../../shared/actions/types'
import { itemActionState } from './actions'
import { actionButtonLabel, actionPendingLabel, actionRefusalNote, actionResultCopy, statusWord, subLineFor } from './copy'

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function agentSummaryOf(agents: readonly AttachedAgent[], sessions: readonly AttachedSession[]): string | null {
  const agent = agents.find((a) => a.activity !== 'dormant') ?? agents[0]
  if (agent) {
    const idleS = Math.round(agent.idleMs / 1000)
    const label = agent.stage ?? agent.agentType
    return agent.activity === 'active' ? `${label} · ${agent.model ?? 'unknown model'} · active ${idleS}s ago` : `${label} hasn't been active in a while.`
  }
  const session = sessions.find((s) => s.role === 'implement')
  if (session) {
    const idleS = Math.round(session.idleMs / 1000)
    return session.activity === 'active' ? `/port:implement session · active ${idleS}s ago` : '/port:implement session · idle'
  }
  return null
}

function stageColorOf(key: string | undefined): string | null {
  if (key === undefined) return null
  return LABEL_DEFAULTS.find((def) => def.key === key)?.color ?? null
}

/** One `<button data-action="item-<action>">` per available action —
 *  `null` when none apply, so an ordinary row (nothing to pause/resume/
 *  retry/gate) never grows an empty strip. Disabled entirely while another
 *  action on the same row is pending, per the plan's own "one action in
 *  flight per item, the row's other buttons are disabled meanwhile". */
function buildActionStrip(row: BoardItemRow): HTMLElement | null {
  const available = OPERATOR_ACTIONS.filter((action) => row.actions[action].available)
  if (available.length === 0) return null

  const state = itemActionState(row.item.repoId, row.item.number)
  const pendingAction = state?.kind === 'pending' ? state.action : null

  const strip = document.createElement('div')
  strip.className = 'board-row__actions'
  for (const action of available) {
    const button = document.createElement('button')
    button.className = 'board-row__action'
    button.dataset.action = `item-${action}`
    button.dataset.repoId = row.item.repoId
    button.dataset.number = String(row.item.number)
    button.dataset.kind = row.item.kind
    button.dataset.stage = row.stageLabel?.key ?? ''
    button.textContent = pendingAction === action ? actionPendingLabel(action) : actionButtonLabel(action)
    button.disabled = pendingAction !== null
    strip.appendChild(button)
  }
  return strip
}

/** The first pause/resume/retry ownership refusal this item carries —
 *  `gate` runs no ownership check, so it never contributes one. A row with
 *  no refusal and no action result at all renders no note. */
function ownershipNoteFor(actions: Readonly<Record<OperatorAction, ActionAvailability>>, item: { readonly number: number; readonly assignees: readonly string[] }): string | null {
  for (const action of ['pause', 'resume', 'retry'] as const) {
    const availability = actions[action]
    if (!availability.available && (availability.reason === 'not-owned' || availability.reason === 'viewer-unknown')) {
      return actionRefusalNote(availability.reason, item)
    }
  }
  return null
}

/** A click's own result while there is one, otherwise the ownership
 *  refusal — never both, and never in a tooltip. */
function actionNoteFor(row: BoardItemRow): string | null {
  const state = itemActionState(row.item.repoId, row.item.number)
  if (state?.kind === 'result') {
    const availability = row.actions[state.action]
    return actionResultCopy({
      action: state.action,
      number: row.item.number,
      plan: availability.available ? availability.plan : null,
      currentStageName: row.stageLabel?.name ?? null,
      result: state.result,
      now: new Date(),
    })
  }
  return ownershipNoteFor(row.actions, row.item)
}

export function buildRow(row: BoardItemRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'board-row'
  el.dataset.url = row.item.url

  const headline = document.createElement('div')
  headline.className = 'board-row__headline'

  const chip = text('span', 'board-row__chip', statusWord(row.displayStatus.status))
  const color = stageColorOf(row.stageLabel?.key)
  if (color !== null) chip.style.setProperty('--chip-color', color)
  headline.appendChild(chip)

  headline.appendChild(text('span', 'board-row__number', `#${String(row.item.number)}`))
  headline.appendChild(text('span', 'board-row__repo', row.item.repo))
  headline.appendChild(text('span', 'board-row__title', row.item.title))
  if (row.item.assignees.length > 0) headline.appendChild(text('span', 'board-row__assignee', `@${row.item.assignees[0] ?? ''}`))

  const strip = buildActionStrip(row)
  if (strip !== null) headline.appendChild(strip)
  el.appendChild(headline)

  const worktreeCount = row.item.worktrees.length
  const subLine = subLineFor({
    displayStatus: row.displayStatus,
    statusEvidence: row.item.statusEvidence,
    waitingOn: row.item.waitingOn,
    linkReason: row.item.linkReason,
    stageAmbiguous: row.item.stageAmbiguous,
    agentSummary: agentSummaryOf(row.item.agents, row.item.sessions),
    worktreeCount,
  })
  if (subLine !== null) el.appendChild(text('div', 'board-row__subline', subLine))

  const note = actionNoteFor(row)
  if (note !== null) el.appendChild(text('div', 'board-row__action-note', note))

  return el
}

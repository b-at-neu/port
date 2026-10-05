// One board item row and its sub-line (#80). `document.createElement`/
// `textContent` only — a title, an assignee, or an agent description arrives
// verbatim from GitHub or a local transcript, never through `innerHTML`.
import type { BoardItemRow } from '../../../shared/board/types'
import type { AttachedAgent, AttachedSession } from '../../../shared/state/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '../../../shared/actions/types'
import type { ActionAvailability, OperatorAction } from '../../../shared/actions/types'
import { itemActionState } from './actions'
import { actionButtonLabel, actionPendingLabel, actionRefusalNote, actionResultCopy, decisionButtonLabel, decisionRefusalNote, reviewPlanButtonLabel, statusWord, subLineFor } from './copy'

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

/** One `<button data-action="decide-<decision>">` per available decision —
 *  never disables for a pending action, since it opens a dialog instead. */
function buildDecisionStrip(row: BoardItemRow): HTMLElement | null {
  const available = OPERATOR_DECISIONS.filter((decision) => row.decisions[decision].available)
  if (available.length === 0) return null

  const strip = document.createElement('div')
  strip.className = 'board-row__actions'
  for (const decision of available) {
    const availability = row.decisions[decision]
    if (!availability.available) continue
    const button = document.createElement('button')
    button.className = 'board-row__action'
    button.dataset.action = `decide-${decision}`
    button.dataset.repoId = row.item.repoId
    button.dataset.number = String(row.item.number)
    button.dataset.kind = row.item.kind
    button.dataset.stage = row.stageLabel?.key ?? ''
    button.dataset.context = JSON.stringify(availability.context)
    button.textContent = decisionButtonLabel(decision)
    strip.appendChild(button)
  }
  return strip
}

/** A decision refusal the operator can act on (`cycle-cap`/
 *  `rebase-decisions`) — `null` when neither decision carries one. */
function decisionNoteFor(row: BoardItemRow): string | null {
  for (const decision of OPERATOR_DECISIONS) {
    const availability = row.decisions[decision]
    if (!availability.available && (availability.reason === 'cycle-cap' || availability.reason === 'rebase-decisions')) {
      return decisionRefusalNote(decision, availability.reason, row.item.number)
    }
  }
  return null
}

/** The first pause/resume/retry/stop ownership refusal this item carries —
 *  `gate` runs no ownership check, so it never contributes one. A row with
 *  no refusal and no action result at all renders no note. */
function ownershipNoteFor(actions: Readonly<Record<OperatorAction, ActionAvailability>>, item: { readonly number: number; readonly assignees: readonly string[] }): string | null {
  for (const action of ['pause', 'resume', 'retry', 'stop'] as const) {
    const availability = actions[action]
    if (!availability.available && (availability.reason === 'not-owned' || availability.reason === 'viewer-unknown')) {
      return actionRefusalNote(availability.reason, item)
    }
  }
  return null
}

/** `stop`'s own applied-with-an-attachment sentence (plan's own **UX
 *  states**) — this app cannot stop an agent or session it did not dispatch
 *  (#106's job), so the write's own success is reported alongside, never
 *  instead of, that fact. `null` when nothing is attached, the same
 *  first-hit-wins priority `agentSummaryOf` above already uses. */
function stopAttachedAgentNote(row: BoardItemRow): string | null {
  const agent = row.item.agents[0]
  const name = agent !== undefined ? (agent.stage ?? agent.agentType) : (row.item.sessions.find((s) => s.role === 'implement') !== undefined ? '/port:implement session' : null)
  if (name === null) return null
  const n = String(row.item.number)
  return `A ${name} is attached to #${n}. This app didn't dispatch it, so it can't stop it — stop it in the session that did, or run stop #${n} in the cockpit.`
}

/** A click's own result while there is one, otherwise the ownership
 *  refusal — never both, and never in a tooltip. */
function actionNoteFor(row: BoardItemRow): string | null {
  const state = itemActionState(row.item.repoId, row.item.number)
  if (state?.kind === 'result') {
    const availability = row.actions[state.action]
    const base = actionResultCopy({
      action: state.action,
      number: row.item.number,
      plan: availability.available ? availability.plan : null,
      currentStageName: row.stageLabel?.name ?? null,
      result: state.result,
      now: new Date(),
    })
    if (state.action === 'stop' && state.result.ok && state.result.outcome.kind === 'applied') {
      const attached = stopAttachedAgentNote(row)
      return attached !== null ? `${base} ${attached}` : base
    }
    return base
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
  // The relay loop's own row badge (#107) — readable without opening the
  // banner above the groups.
  if (row.relay !== null) headline.appendChild(text('span', 'board-row__relay-badge', 'Waiting on you'))

  // The plan gate's own row entry point (#92) — an issue at `plan review`
  // offers a direct route into the dialog's Reviewing step, carrying
  // repoId/number verbatim, the same dataset idiom the action strip below
  // already uses.
  if (row.item.kind === 'issue' && row.stageLabel?.key === 'planReview') {
    const reviewButton = document.createElement('button')
    reviewButton.className = 'board-row__review'
    reviewButton.dataset.action = 'gate-review'
    reviewButton.dataset.repoId = row.item.repoId
    reviewButton.dataset.number = String(row.item.number)
    reviewButton.textContent = reviewPlanButtonLabel()
    headline.appendChild(reviewButton)
  }

  const strip = buildActionStrip(row)
  if (strip !== null) headline.appendChild(strip)
  const decisionStrip = buildDecisionStrip(row)
  if (decisionStrip !== null) headline.appendChild(decisionStrip)
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
  const decisionNote = decisionNoteFor(row)
  if (decisionNote !== null) el.appendChild(text('div', 'board-row__action-note', decisionNote))

  return el
}

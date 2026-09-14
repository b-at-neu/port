// One board item row and its sub-line (#80). `document.createElement`/
// `textContent` only — a title, an assignee, or an agent description arrives
// verbatim from GitHub or a local transcript, never through `innerHTML`.
import type { BoardItemRow } from '../../../shared/board/types'
import type { AttachedAgent, AttachedSession } from '../../../shared/state/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import { statusWord, subLineFor } from './copy'

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

  return el
}

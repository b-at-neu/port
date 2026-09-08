// The sessions-and-agents picker screen (#83): repository -> sessions ->
// transcript. Every node is built with `document.createElement`/`textContent`
// — a session's title and an agent's description arrive verbatim from a
// local transcript file. #80 picks a UI framework and this screen is what
// it replaces; until then it stays plain DOM, the same contract
// `repositories.ts`/`worktrees.ts` already hold.
import type { RepoId } from '../../shared/repos'
import type { AgentRecord, SessionFailureKind, SessionRecord, SessionScan } from '../../shared/sessions/types'

export type SessionsPickerState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly kind: SessionFailureKind; readonly message: string }
  /** The IPC round trip itself failed — distinct from every `SessionFailureKind`
   *  above, which are answers `readSessionState` itself returned. */
  | { readonly status: 'unreachable' }
  | { readonly status: 'ready'; readonly scan: Extract<SessionScan, { ok: true }> }

const TITLE_MAX = 80

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function failureCopy(kind: SessionFailureKind, message: string): string {
  switch (kind) {
    case 'sdk-unavailable':
      return "Port couldn't load the Claude Agent SDK, so it can't list sessions. Reinstall the app's dependencies and try again."
    case 'sdk-failed':
      return `The Claude Agent SDK failed while listing sessions: ${message}`
    case 'claude-home-missing':
      return 'No projects directory under your Claude home, so there are no local transcripts to read.'
    case 'projects-unreadable':
      return `Couldn't read your Claude projects directory — ${message}`
  }
}

/** Exported for the transcript header (#83's UX spec: "the session title"
 *  for a session transcript) so main.ts never re-derives this from a raw id. */
export function titleOf(session: SessionRecord): string {
  const raw = session.customTitle ?? session.summary ?? session.firstPrompt ?? '(untitled session)'
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX)}…` : raw
}

function relativeTime(idleMs: number): string {
  const seconds = Math.max(0, Math.round(idleMs / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function buildAgentRow(agent: AgentRecord, sessionId: string): HTMLElement {
  const row = document.createElement('button')
  row.className = 'session-row session-row--agent'
  row.dataset.action = 'open-transcript'
  row.dataset.sessionId = sessionId
  row.dataset.agentId = agent.agentId

  const parts = [
    agent.stage ?? agent.agentType,
    agent.model ?? null,
    agent.itemNumber !== null ? `#${agent.itemNumber}` : null,
    agent.description ?? null,
    relativeTime(agent.idleMs),
  ].filter((part): part is string => part !== null && part !== '')
  row.textContent = parts.join(' · ')
  return row
}

function buildSessionRow(session: SessionRecord, agentsById: ReadonlyMap<string, AgentRecord>): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'session-item'

  const button = document.createElement('button')
  button.className = 'session-row'
  button.dataset.action = 'open-transcript'
  button.dataset.sessionId = session.sessionId
  button.dataset.agentId = ''
  button.appendChild(text('span', 'session-row__title', titleOf(session)))

  const metaParts = [
    session.role !== 'other' ? session.role : null,
    session.itemNumber !== null ? `#${session.itemNumber}` : null,
    session.gitBranch,
    relativeTime(session.idleMs),
  ].filter((part): part is string => part !== null && part !== '')
  button.appendChild(text('span', 'session-row__meta', metaParts.join(' · ')))
  wrapper.appendChild(button)

  if (session.agentIds.length > 0) {
    const agentsList = document.createElement('div')
    agentsList.className = 'session-agents'
    for (const agentId of session.agentIds) {
      const agent = agentsById.get(agentId)
      if (agent !== undefined) agentsList.appendChild(buildAgentRow(agent, session.sessionId))
    }
    wrapper.appendChild(agentsList)
  }

  return wrapper
}

function buildHeader(repoLabel: string): HTMLElement {
  const header = document.createElement('div')
  header.className = 'sessions-header'

  const back = document.createElement('button')
  back.className = 'sessions-header__back'
  back.textContent = '‹ Back'
  back.dataset.action = 'back-to-repos'
  header.appendChild(back)

  header.appendChild(text('span', 'sessions-header__title', repoLabel))

  const rescan = document.createElement('button')
  rescan.className = 'sessions-header__rescan'
  rescan.textContent = 'Rescan'
  rescan.dataset.action = 'rescan-sessions'
  header.appendChild(rescan)

  return header
}

export function renderSessionsPicker(container: HTMLElement, repoId: RepoId, repoLabel: string, state: SessionsPickerState): void {
  container.textContent = ''
  container.appendChild(buildHeader(repoLabel))

  if (state.status === 'loading') {
    container.appendChild(text('p', 'sessions-status', 'Reading local sessions…'))
    return
  }

  if (state.status === 'error') {
    container.appendChild(text('p', 'sessions-status sessions-status--error', failureCopy(state.kind, state.message)))
    return
  }

  if (state.status === 'unreachable') {
    container.appendChild(text('p', 'sessions-status sessions-status--error', 'Could not reach the main process.'))
    return
  }

  const scan = state.scan
  const sessions = scan.sessions.filter((session) => session.repoId === repoId).slice().sort((a, b) => a.idleMs - b.idleMs)
  const agentsById = new Map(scan.agents.filter((agent) => agent.repoId === repoId).map((agent) => [agent.agentId, agent] as const))

  if (sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sessions-empty'
    empty.appendChild(text('p', 'sessions-empty__title', 'No sessions recorded for this repository yet.'))
    empty.appendChild(text('p', 'sessions-empty__hint', 'A session appears here once Claude has run in this folder or one of its worktrees.'))
    container.appendChild(empty)
  } else {
    const list = document.createElement('div')
    list.className = 'sessions-list'
    for (const session of sessions) list.appendChild(buildSessionRow(session, agentsById))
    container.appendChild(list)
  }

  const unresolvedCount = scan.unresolved.length
  const unreadableCount = scan.unreadable.length
  if (unresolvedCount > 0 || unreadableCount > 0) {
    const parts: string[] = []
    if (unresolvedCount > 0) parts.push(`${unresolvedCount} session${unresolvedCount === 1 ? '' : 's'} couldn't be located on disk`)
    if (unreadableCount > 0) parts.push(`${unreadableCount} agent record${unreadableCount === 1 ? '' : 's'} ${unreadableCount === 1 ? 'was' : 'were'} unreadable`)
    container.appendChild(text('p', 'sessions-footnote', `${parts.join(' · ')}.`))
  }
}

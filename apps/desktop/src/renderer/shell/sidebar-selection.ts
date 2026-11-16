// Which sidebar row the routed screen is showing, derived from the route alone.
import { useMatch } from '@tanstack/react-router'
import type { SessionKey } from '@/types/hosting'
import type { ActiveRepoScreen, PipelineRow, PipelineSessionRow, SidebarSelection } from '@/types/shell'
import { ROUTE_IDS } from '@/renderer/router/routes'

export const SELECTED_ROW_CLASS = 'bg-selection text-primary-text'

export function sidebarSelectionOf(route: { readonly sessionKey: string | null | undefined; readonly transcriptSessionId: string | undefined; readonly transcriptAgentId: string | null | undefined }): SidebarSelection {
  if (route.sessionKey !== undefined && route.sessionKey !== null && route.sessionKey !== '') return { kind: 'session', sessionKey: route.sessionKey as SessionKey }
  if (route.transcriptSessionId !== undefined && route.transcriptSessionId !== '') return { kind: 'transcript', sessionId: route.transcriptSessionId, agentId: route.transcriptAgentId ?? null }
  return null
}

export function isUserSessionSelected(sessionKey: SessionKey, selection: SidebarSelection): boolean {
  return selection !== null && selection.kind === 'session' && selection.sessionKey === sessionKey
}

export function isPipelineRowSelected(row: PipelineSessionRow, selection: SidebarSelection): boolean {
  if (selection === null) return false
  if (selection.kind === 'session') return row.sessionKey === selection.sessionKey
  return row.transcript !== null && row.transcript.sessionId === selection.sessionId && row.transcript.agentId === selection.agentId
}

/** The first matching row in render order, so at most one pipeline row is ever selected. */
export function selectedPipelineRowKey(rows: readonly PipelineRow[], selection: SidebarSelection): string | null {
  for (const repo of rows) {
    const match = repo.sessions.find((session) => isPipelineRowSelected(session, selection))
    if (match !== undefined) return match.key
  }
  return null
}

/** A collapsed repo hides its rows, so it takes the selected style when the open screen or session is inside it. */
export function repoHoldsSelection(row: PipelineRow, collapsed: boolean, selectedKey: string | null, activeScreen: ActiveRepoScreen | null, selection: SidebarSelection = null): 'session' | 'screen' | null {
  if (!collapsed) return null
  if (activeScreen?.repoId === row.repoId) return 'screen'
  if (selectedKey !== null && row.sessions.some((session) => session.key === selectedKey)) return 'session'
  if (selection !== null && selection.kind === 'session' && row.userSessions.some((session) => session.sessionKey === selection.sessionKey)) return 'session'
  return null
}

export function repoToggleLabel(name: string, collapsed: boolean, holds: 'session' | 'screen' | null): string {
  if (!collapsed) return `Collapse ${name}`
  if (holds === 'screen') return `Expand ${name}, contains the open screen`
  return holds === 'session' ? `Expand ${name}, contains the open session` : `Expand ${name}`
}

export function useSidebarSelection(): SidebarSelection {
  const sessionKey = useMatch({ from: ROUTE_IDS.session, shouldThrow: false, select: (match) => match.search.key })
  const transcriptSessionId = useMatch({ from: ROUTE_IDS.transcript, shouldThrow: false, select: (match) => match.params.sessionId })
  const transcriptAgentId = useMatch({ from: ROUTE_IDS.transcript, shouldThrow: false, select: (match) => match.search.agentId })
  return sidebarSelectionOf({ sessionKey, transcriptSessionId, transcriptAgentId })
}

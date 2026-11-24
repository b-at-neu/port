// History's decisions — pure: which of four views a scan resolves to, and how a list groups.
import type { SessionMarks } from '@/types/hosting'
import type { AgentRecord, SessionRecord, SessionScan } from '@/types/sessions'
import type { HistoryGroups } from '@/types/history'
import type { RepoId } from '@/utils/repos'
import { failureCopy, footnote } from '@/renderer/history/copy'

export type HistoryGroupKind = 'pinned' | 'recent' | 'archived'

export type HistoryView =
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'all-archived' }
  | {
      readonly kind: 'list'
      readonly groups: readonly { readonly kind: HistoryGroupKind; readonly rows: readonly SessionRecord[] }[]
      readonly showHeaders: boolean
      readonly agentsBySession: ReadonlyMap<string, readonly AgentRecord[]>
      readonly note: string | null
    }

interface HistoryViewParams {
  readonly repo: RepoId | null
  readonly marks: SessionMarks | undefined
  readonly showArchived: boolean
}

/** Archived wins over pinned: an archived-and-pinned session goes to `archived` (it still carries its pin glyph there) and is hidden unless `showArchived` is set. */
export function groupHistory(sessions: readonly SessionRecord[], marks: SessionMarks, showArchived: boolean): HistoryGroups {
  const pinned: SessionRecord[] = []
  const recent: SessionRecord[] = []
  const archived: SessionRecord[] = []

  for (const session of sessions) {
    const isArchived = marks.archived.includes(session.sessionId)
    const isPinned = marks.pinned.includes(session.sessionId)
    if (isArchived) {
      if (showArchived) archived.push(session)
      continue
    }
    if (isPinned) pinned.push(session)
    else recent.push(session)
  }

  return { pinned, recent, archived }
}

export function historyView(scan: SessionScan, params: HistoryViewParams): HistoryView {
  if (!scan.ok) return { kind: 'failed', message: failureCopy(scan.kind, scan.message) }
  const { repo, marks, showArchived } = params
  const filtered = (repo === null ? scan.sessions : scan.sessions.filter((session) => session.repoId === repo)).slice().sort((a, b) => a.idleMs - b.idleMs)
  if (filtered.length === 0) return { kind: 'empty' }

  const groups: HistoryGroups = marks !== undefined ? groupHistory(filtered, marks, showArchived) : { pinned: [], recent: filtered, archived: [] }
  const groupList = (
    [
      { kind: 'pinned', rows: groups.pinned },
      { kind: 'recent', rows: groups.recent },
      { kind: 'archived', rows: groups.archived },
    ] as const
  ).filter((group) => group.rows.length > 0)
  if (groupList.length === 0) return { kind: 'all-archived' }

  const agentsBySession = new Map<string, AgentRecord[]>()
  for (const agent of scan.agents) {
    if (repo !== null && agent.repoId !== repo) continue
    const list = agentsBySession.get(agent.sessionId) ?? []
    list.push(agent)
    agentsBySession.set(agent.sessionId, list)
  }
  return { kind: 'list', groups: groupList, showHeaders: groupList.length > 1, agentsBySession, note: footnote(scan.unresolved.length, scan.unreadable.length) }
}

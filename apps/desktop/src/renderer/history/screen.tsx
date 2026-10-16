// The History screen — past sessions and their agents, across every repository, reached from the sidebar.
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, History as HistoryIcon } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Button } from '@/renderer/components/ui/button'
import { Checkbox } from '@/renderer/components/ui/checkbox'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { relativeTime } from '@/renderer/lib/relative-time'
import { startFromTranscript } from '@/renderer/session/actions'
import { useSessionMarks } from '@/renderer/session/marks'
import { SessionMarkMenu, SessionPinGlyph } from '@/renderer/components/session-mark-menu'
import { groupHistory } from '@/renderer/history/model'
import type { HistoryGroups } from '@/types/history'
import { agentLabel, sessionLabel } from '@/utils/sessions/label'
import type { SessionMarks } from '@/types/hosting'
import type { AgentRecord, SessionRecord } from '@/types/sessions'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { ALL_ARCHIVED_EMPTY, failureCopy, footnote, groupHeader, SHOW_ARCHIVED_ACTION } from '@/renderer/history/copy'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

function repoTagFor(repos: readonly RepositoryEntry[] | undefined, repoId: RepoId | null): string {
  if (repoId === null) return ''
  const entry = repos?.find((candidate) => candidate.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function HistoryScreen() {
  const search = useSearch({ from: ROUTE_IDS.history })
  const navigate = useNavigate()
  const scan = useIpcQuery('sessions:scan')
  const repos = useIpcQuery('repos:list')
  const marks = useSessionMarks()
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const showArchived = search.archived ?? false

  function openTranscript(sessionId: string, agentId: string | null, title: string): void {
    void navigate({ to: ROUTE_IDS.transcript, params: { sessionId }, search: { agentId, from: 'history', focusIndex: null, title, item: null } })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <ScreenHeader className="justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span>History</span>
          <Select value={search.repo ?? 'all'} onValueChange={(value) => void navigate({ to: ROUTE_IDS.history, search: { ...search, repo: value === 'all' ? null : (value as RepoId) } })}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repositories</SelectItem>
              {readyRepos.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.config.repo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 text-small text-foreground-secondary">
            <Checkbox checked={showArchived} onCheckedChange={(checked) => void navigate({ to: ROUTE_IDS.history, search: { ...search, archived: checked === true } })} />
            {SHOW_ARCHIVED_ACTION}
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="small" onClick={() => void navigate({ to: ROUTE_IDS.search, search: { repo: search.repo ?? null } })}>
            Search
          </Button>
          <Button variant="outline" size="small" onClick={() => void scan.refetch()}>
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Rescan
          </Button>
        </div>
      </ScreenHeader>

      {scan.status === 'pending' ? (
        <div className="flex flex-col gap-1 px-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : scan.status === 'error' ? (
        <ErrorBanner message="Could not reach the main process." className="mx-4" />
      ) : !scan.data.ok ? (
        <ErrorBanner message={failureCopy(scan.data.kind, scan.data.message)} className="mx-4" />
      ) : (
        <>
          {marks.status === 'error' ? <ErrorBanner message="Couldn't load pins and archives. Rescan to try again." className="mx-4" /> : null}
          <HistoryList
            repo={search.repo ?? null}
            sessions={scan.data.sessions}
            agents={scan.data.agents}
            unresolved={scan.data.unresolved.length}
            unreadable={scan.data.unreadable.length}
            repos={readyRepos}
            marks={marks.data}
            showArchived={showArchived}
            onShowArchived={() => void navigate({ to: ROUTE_IDS.history, search: { ...search, archived: true } })}
            onOpen={openTranscript}
          />
        </>
      )}
    </div>
  )
}

function HistoryList({
  repo,
  sessions,
  agents,
  unresolved,
  unreadable,
  repos,
  marks,
  showArchived,
  onShowArchived,
  onOpen,
}: {
  readonly repo: RepoId | null
  readonly sessions: readonly SessionRecord[]
  readonly agents: readonly AgentRecord[]
  readonly unresolved: number
  readonly unreadable: number
  readonly repos: readonly Extract<RepositoryEntry, { status: 'ready' }>[]
  readonly marks: SessionMarks | undefined
  readonly showArchived: boolean
  readonly onShowArchived: () => void
  readonly onOpen: (sessionId: string, agentId: string | null, title: string) => void
}) {
  const filtered = (repo === null ? sessions : sessions.filter((session) => session.repoId === repo)).slice().sort((a, b) => a.idleMs - b.idleMs)
  const agentsBySession = new Map<string, AgentRecord[]>()
  for (const agent of agents) {
    if (repo !== null && agent.repoId !== repo) continue
    const list = agentsBySession.get(agent.sessionId) ?? []
    list.push(agent)
    agentsBySession.set(agent.sessionId, list)
  }
  const note = footnote(unresolved, unreadable)

  if (filtered.length === 0) {
    return <EmptyState icon={HistoryIcon} message="No sessions recorded for this repository yet." className="px-4 py-6" data-slot="history-empty" />
  }

  const groups: HistoryGroups = marks !== undefined ? groupHistory(filtered, marks, showArchived) : { pinned: [], recent: filtered, archived: [] }
  const groupList = (
    [
      { kind: 'pinned', rows: groups.pinned },
      { kind: 'recent', rows: groups.recent },
      { kind: 'archived', rows: groups.archived },
    ] as const
  ).filter((group) => group.rows.length > 0)
  const showHeaders = groupList.length > 1

  if (groupList.length === 0) {
    return <EmptyState icon={HistoryIcon} message={ALL_ARCHIVED_EMPTY} action={{ label: SHOW_ARCHIVED_ACTION, onClick: onShowArchived }} className="px-4 py-6" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {groupList.map((group) => (
        <div key={group.kind} data-slot={`history-group-${group.kind}`}>
          {showHeaders ? <div className="px-4 py-2 text-meta font-medium text-muted-foreground">{groupHeader(group.kind)}</div> : null}
          {group.rows.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              agents={agentsBySession.get(session.sessionId) ?? []}
              repoTag={repoTagFor(repos, session.repoId)}
              pinned={marks?.pinned.includes(session.sessionId) ?? false}
              marks={marks}
              onOpen={onOpen}
            />
          ))}
        </div>
      ))}
      {note !== null ? <p className="px-4 py-2 text-meta text-muted-foreground">{note}</p> : null}
    </div>
  )
}

function SessionRow({
  session,
  agents,
  repoTag,
  pinned,
  marks,
  onOpen,
}: {
  readonly session: SessionRecord
  readonly agents: readonly AgentRecord[]
  readonly repoTag: string
  readonly pinned: boolean
  readonly marks: SessionMarks | undefined
  readonly onOpen: (sessionId: string, agentId: string | null, title: string) => void
}) {
  const label = sessionLabel(session)
  const canHost = session.cwd !== null
  const metaParts = [session.role !== 'other' ? session.role : null, session.itemNumber !== null ? `#${String(session.itemNumber)}` : null, session.gitBranch, relativeTime(session.idleMs)].filter(
    (part): part is string => part !== null && part !== '',
  )

  return (
    <div className="flex flex-col" data-slot="session-row">
      <div className="flex h-9 items-center gap-2 px-4">
        <button type="button" onClick={() => onOpen(session.sessionId, null, label)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          {pinned ? <SessionPinGlyph /> : null}
          <span className="truncate text-small">{label}</span>
          <span className="shrink-0 truncate text-meta text-muted-foreground">{metaParts.join(' · ')}</span>
        </button>
        <span className="shrink-0 text-meta text-muted-foreground">{repoTag}</span>
        {canHost ? (
          <div className="flex shrink-0 gap-1">
            <Button variant="outline" size="small" onClick={() => void startFromTranscript(session.repoId as RepoId, session.sessionId, 'resume')}>
              Resume
            </Button>
            <Button variant="outline" size="small" onClick={() => void startFromTranscript(session.repoId as RepoId, session.sessionId, 'fork')}>
              Fork
            </Button>
          </div>
        ) : null}
        <SessionMarkMenu sessionId={session.sessionId} marks={marks} />
      </div>
      {agents.length > 0 ? (
        <div className="flex flex-col pl-6">
          {agents.map((agent) => (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => onOpen(session.sessionId, agent.agentId, agentLabel(agent))}
              className="flex h-7 items-center gap-2 rounded-md px-4 text-left text-meta text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              {[agentLabel(agent), agent.model, agent.description, relativeTime(agent.idleMs)].filter((part): part is string => part !== null && part !== '').join(' · ')}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

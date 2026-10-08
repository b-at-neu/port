// The History screen — past sessions and their agents, across every repository, reached from the sidebar.
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, History as HistoryIcon } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { ScreenHeader } from '../components/screen-header'
import { useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/routes'
import { relativeTime } from '../lib/relative-time'
import { startFromTranscript } from '../session/actions'
import { agentLabel, sessionLabel } from '../../../shared/sessions/label'
import type { AgentRecord, SessionRecord } from '../../../shared/sessions/types'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import { failureCopy, footnote } from './copy'

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
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []

  function openTranscript(sessionId: string, agentId: string | null, title: string): void {
    void navigate({ to: ROUTE_IDS.transcript, params: { sessionId }, search: { agentId, from: 'history', focusIndex: null, title } })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <ScreenHeader className="justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span>History</span>
          <Select value={search.repo ?? 'all'} onValueChange={(value) => void navigate({ to: ROUTE_IDS.history, search: { repo: value === 'all' ? null : (value as RepoId) } })}>
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
        <HistoryList repo={search.repo ?? null} sessions={scan.data.sessions} agents={scan.data.agents} unresolved={scan.data.unresolved.length} unreadable={scan.data.unreadable.length} repos={readyRepos} onOpen={openTranscript} />
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
  onOpen,
}: {
  readonly repo: RepoId | null
  readonly sessions: readonly SessionRecord[]
  readonly agents: readonly AgentRecord[]
  readonly unresolved: number
  readonly unreadable: number
  readonly repos: readonly Extract<RepositoryEntry, { status: 'ready' }>[]
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {filtered.map((session) => (
        <SessionRow key={session.sessionId} session={session} agents={agentsBySession.get(session.sessionId) ?? []} repoTag={repoTagFor(repos, session.repoId)} onOpen={onOpen} />
      ))}
      {note !== null ? <p className="px-4 py-2 text-meta text-muted-foreground">{note}</p> : null}
    </div>
  )
}

function SessionRow({
  session,
  agents,
  repoTag,
  onOpen,
}: {
  readonly session: SessionRecord
  readonly agents: readonly AgentRecord[]
  readonly repoTag: string
  readonly onOpen: (sessionId: string, agentId: string | null, title: string) => void
}) {
  const label = sessionLabel(session)
  const hostRepoId = session.worktreePath === null ? session.repoId : null
  const metaParts = [session.role !== 'other' ? session.role : null, session.itemNumber !== null ? `#${String(session.itemNumber)}` : null, session.gitBranch, relativeTime(session.idleMs)].filter(
    (part): part is string => part !== null && part !== '',
  )

  return (
    <div className="flex flex-col" data-slot="session-row">
      <div className="flex h-9 items-center gap-2 px-4">
        <button type="button" onClick={() => onOpen(session.sessionId, null, label)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <span className="truncate text-small">{label}</span>
          <span className="shrink-0 truncate text-meta text-muted-foreground">{metaParts.join(' · ')}</span>
        </button>
        <span className="shrink-0 text-meta text-muted-foreground">{repoTag}</span>
        {hostRepoId !== null ? (
          <div className="flex shrink-0 gap-1">
            <Button variant="outline" size="small" onClick={() => void startFromTranscript(hostRepoId, session.sessionId, 'resume')}>
              Resume
            </Button>
            <Button variant="outline" size="small" onClick={() => void startFromTranscript(hostRepoId, session.sessionId, 'fork')}>
              Fork
            </Button>
          </div>
        ) : null}
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

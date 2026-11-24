// The History screen — past sessions and their agents, across every repository, reached from the sidebar.
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, History as HistoryIcon } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Button } from '@/renderer/components/ui/button'
import { Checkbox } from '@/renderer/components/ui/checkbox'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { Page } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { relativeTime } from '@/renderer/lib/time'
import { startFromTranscript } from '@/renderer/session/actions'
import { useSessionMarks } from '@/renderer/session/marks'
import { SessionRow } from '@/renderer/components/session-row'
import { historyView } from '@/renderer/history/model'
import type { HistoryView } from '@/renderer/history/model'
import { agentLabel, sessionLabel } from '@/utils/sessions/label'
import type { SessionMarks } from '@/types/hosting'
import type { AgentRecord, SessionRecord } from '@/types/sessions'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import {
  ALL_ARCHIVED_EMPTY,
  FORK_ACTION,
  groupHeader,
  HISTORY_TITLE,
  MARKS_ERROR,
  NO_SESSIONS_EMPTY,
  RESCAN_ACTION,
  RESUME_ACTION,
  SCAN_UNREACHABLE,
  SHOW_ARCHIVED_ACTION,
} from '@/renderer/history/copy'
import { ALL_REPOSITORIES, SEARCH_ACTION } from '@/renderer/lib/copy'

type OpenTranscript = (sessionId: string, agentId: string | null, title: string) => void

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
  const scan = useIpcQuery('history.scan')
  const repos = useIpcQuery('repos.list')
  const marks = useSessionMarks()
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const showArchived = search.archived ?? false
  const view = scan.data === undefined ? undefined : historyView(scan.data, { repo: search.repo ?? null, marks: marks.data, showArchived })
  const state = pageState({ data: view, status: scan.status }, (v) => v.kind === 'empty' || v.kind === 'all-archived')

  function openTranscript(sessionId: string, agentId: string | null, title: string): void {
    void navigate({ to: ROUTE_IDS.transcript, params: { sessionId }, search: { agentId, from: 'history', focusIndex: null, title, item: null } })
  }

  return (
    <Page
      variant="list"
      header={
        <ScreenHeader className="justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span>{HISTORY_TITLE}</span>
            <Select value={search.repo ?? 'all'} onValueChange={(value) => void navigate({ to: ROUTE_IDS.history, search: { ...search, repo: value === 'all' ? null : (value as RepoId) } })}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{ALL_REPOSITORIES}</SelectItem>
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
              {SEARCH_ACTION}
            </Button>
            <Button variant="outline" size="small" onClick={() => void scan.refetch()}>
              <RefreshCw aria-hidden="true" className="size-3.5" />
              {RESCAN_ACTION}
            </Button>
          </div>
        </ScreenHeader>
      }
      state={state}
      errorMessage={SCAN_UNREACHABLE}
      onRetry={() => void scan.refetch()}
      empty={
        view?.kind === 'all-archived' ? (
          <EmptyState icon={HistoryIcon} message={ALL_ARCHIVED_EMPTY} action={{ label: SHOW_ARCHIVED_ACTION, onClick: () => void navigate({ to: ROUTE_IDS.history, search: { ...search, archived: true } }) }} className="px-4 py-6" />
        ) : (
          <EmptyState icon={HistoryIcon} message={NO_SESSIONS_EMPTY} className="px-4 py-6" data-slot="history-empty" />
        )
      }
    >
      {view === undefined ? null : (
        <>
          {marks.status === 'error' ? <ErrorBanner message={MARKS_ERROR} className="mx-4 my-2" /> : null}
          <HistoryBody view={view} repos={readyRepos} marks={marks.data} onOpen={openTranscript} />
        </>
      )}
    </Page>
  )
}

function HistoryBody({ view, repos, marks, onOpen }: { readonly view: HistoryView; readonly repos: readonly RepositoryEntry[]; readonly marks: SessionMarks | undefined; readonly onOpen: OpenTranscript }) {
  if (view.kind === 'failed') return <ErrorBanner message={view.message} className="mx-4 my-2" />
  if (view.kind !== 'list') return null
  return (
    <div className="flex flex-col">
      {view.groups.map((group) => (
        <div key={group.kind} data-slot={`history-group-${group.kind}`}>
          {view.showHeaders ? <div className="px-4 py-2 text-meta font-medium text-muted-foreground">{groupHeader(group.kind)}</div> : null}
          {group.rows.map((session) => (
            <HistoryEntry key={session.sessionId} session={session} agents={view.agentsBySession.get(session.sessionId) ?? []} repoTag={repoTagFor(repos, session.repoId)} marks={marks} onOpen={onOpen} />
          ))}
        </div>
      ))}
      {view.note !== null ? <p className="px-4 py-2 text-meta text-muted-foreground">{view.note}</p> : null}
    </div>
  )
}

function HistoryEntry({
  session,
  agents,
  repoTag,
  marks,
  onOpen,
}: {
  readonly session: SessionRecord
  readonly agents: readonly AgentRecord[]
  readonly repoTag: string
  readonly marks: SessionMarks | undefined
  readonly onOpen: OpenTranscript
}) {
  const label = sessionLabel(session)
  const canHost = session.cwd !== null
  const metaParts = [session.role !== 'other' ? session.role : null, session.itemNumber !== null ? `#${String(session.itemNumber)}` : null, session.gitBranch, relativeTime(session.idleMs)].filter(
    (part): part is string => part !== null && part !== '',
  )

  return (
    <SessionRow
      density="list"
      title={label}
      meta={metaParts.join(' · ')}
      onOpen={() => onOpen(session.sessionId, null, label)}
      marks={{ sessionId: session.sessionId, marks }}
      trailing={
        <>
          <span className="shrink-0 text-meta text-muted-foreground">{repoTag}</span>
          {canHost ? (
            <div className="flex shrink-0 gap-1">
              <Button variant="outline" size="small" onClick={() => void startFromTranscript(session.repoId as RepoId, session.sessionId, 'resume')}>
                {RESUME_ACTION}
              </Button>
              <Button variant="outline" size="small" onClick={() => void startFromTranscript(session.repoId as RepoId, session.sessionId, 'fork')}>
                {FORK_ACTION}
              </Button>
            </div>
          ) : null}
        </>
      }
    >
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
    </SessionRow>
  )
}

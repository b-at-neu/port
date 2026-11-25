// The per-repository page — back link, New session/Transcripts/Remove,
// and the Overview/Worktrees/Denials tabs.
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { Page } from '@/renderer/components/page'
import { ScreenBody } from '@/renderer/components/screen'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/app/routes'
import type { DenialsGroup } from '@/types/router'
import type { RepoId } from '@/utils/repos'
import { openNewSessionDialog } from '@/renderer/app/stores'
import { NOT_REGISTERED, OPEN_REPOSITORIES, REMOVE_DESCRIPTION, REMOVE_REPOSITORY, removeTitle, removingCopy, REPO_INVOKE_ERROR } from '@/renderer/repositories/copy'
import { registryFailureCopy, removeResultToast, repoLookup, repoName } from '@/renderer/repositories/model'
import { DenialsTab } from '@/renderer/repositories/denials-tab'
import { OverviewTab } from '@/renderer/repositories/overview-tab'
import { WorktreesTab } from '@/renderer/repositories/worktrees-tab'

export function RepoScreen() {
  const { repoId } = useParams({ from: ROUTE_IDS.settingsRepo })
  const search = useSearch({ from: ROUTE_IDS.settingsRepo })
  const navigate = useNavigate()
  const reposQuery = useIpcQuery('repos.list')
  const lookup = repoLookup(reposQuery, repoId)
  const entry = lookup.entry
  const name = entry === null ? repoId : repoName(entry)

  const remove = useActionMutation('repos.remove', {
    confirm: () => ({ title: removeTitle(name), description: REMOVE_DESCRIPTION, confirmLabel: REMOVE_REPOSITORY, tone: 'destructive' }),
    toast: { pending: removingCopy(name), result: (result) => removeResultToast(name, result) },
    invalidates: ['repos.list'],
    onResult: (result) => {
      if (result.ok) void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } })
    },
  })

  const tab = search.tab ?? 'overview'
  const denialsGroup = search.denialsGroup ?? 'command'

  function setTab(next: 'overview' | 'worktrees' | 'denials'): void {
    void navigate({ to: ROUTE_IDS.settingsRepo, params: { repoId }, search: { tab: next, denialsGroup } })
  }

  function setDenialsGroup(next: DenialsGroup): void {
    void navigate({ to: ROUTE_IDS.settingsRepo, params: { repoId }, search: { tab: 'denials', denialsGroup: next } })
  }

  const header =
    entry === null ? (
      <ScreenHeader>Settings › Repositories</ScreenHeader>
    ) : (
      <ScreenHeader className="justify-between">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => void navigate({ to: ROUTE_IDS.settings, search: { section: 'general' } })} className="text-muted-foreground hover:underline">
            Settings
          </button>
          <span className="text-muted-foreground">›</span>
          <button type="button" onClick={() => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } })} className="text-muted-foreground hover:underline">
            Repositories
          </button>
          <span className="text-muted-foreground">›</span>
          <span>{name}</span>
        </div>
        <div className="flex items-center gap-2">
          {'config' in entry ? (
            <Button variant="outline" size="small" onClick={() => openNewSessionDialog({ kind: 'repo', repoId: repoId as RepoId })}>
              New session
            </Button>
          ) : null}
          <Button variant="outline" size="small" onClick={() => void navigate({ to: ROUTE_IDS.history, search: { repo: repoId as RepoId } })}>
            History
          </Button>
          <Button variant="outline" size="small" disabled={remove.pending} onClick={() => remove.request({ id: repoId as RepoId })}>
            Remove
          </Button>
          {remove.confirmDialog}
        </div>
      </ScreenHeader>
    )

  return (
    <Page
      header={header}
      variant="list"
      state={lookup.state}
      errorMessage={REPO_INVOKE_ERROR}
      onRetry={() => void reposQuery.refetch()}
      empty={<EmptyState icon={FolderGit2} message={NOT_REGISTERED} action={{ label: OPEN_REPOSITORIES, onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }} className="p-6" />}
    >
      {lookup.failure !== null ? <ErrorBanner message={registryFailureCopy(lookup.failure)} className="m-4" /> : null}
      {entry !== null && 'config' in entry ? (
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'overview' | 'worktrees' | 'denials')} className="flex h-full min-h-0 flex-col overflow-hidden">
          <TabsList className="mx-4 mt-2 self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="worktrees">Worktrees</TabsTrigger>
            <TabsTrigger value="denials">Denials</TabsTrigger>
          </TabsList>
          <ScreenBody variant="list">
            {tab === 'overview' ? <OverviewTab entry={entry} repoId={repoId as RepoId} /> : null}
            {tab === 'worktrees' ? <WorktreesTab repoId={repoId as RepoId} entry={entry} /> : null}
            {tab === 'denials' ? <DenialsTab repoId={repoId as RepoId} group={denialsGroup} onGroupChange={setDenialsGroup} /> : null}
          </ScreenBody>
        </Tabs>
      ) : null}
      {entry !== null && !('config' in entry) ? <OverviewTab entry={entry} repoId={repoId as RepoId} /> : null}
    </Page>
  )
}

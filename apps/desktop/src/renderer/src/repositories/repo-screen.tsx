// The per-repository page (#319, plan's own **UX states**) — back link,
// New session/Transcripts/Remove, and the Overview/Worktrees/Denials tabs.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '../components/empty-state'
import { ipcQueryOptions, useIpcMutation, useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/legacy-view'
import type { ReposListResponse } from '../../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import { legacyActions } from '../shell/legacy-actions'
import { startNewSession } from '../session/controller'
import { DenialsTab } from './denials-tab'
import { OverviewTab } from './overview-tab'
import { WorktreesTab } from './worktrees-tab'

function repoName(entry: RepositoryEntry): string {
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function RepoScreen() {
  const { repoId } = useParams({ from: ROUTE_IDS.repo })
  const search = useSearch({ from: ROUTE_IDS.repo })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const reposQuery = useIpcQuery('repos:list')
  const removeMutation = useIpcMutation('repos:remove')
  const [removeOpen, setRemoveOpen] = useState(false)

  const entry = reposQuery.data?.ok === true ? reposQuery.data.repositories.find((r) => r.id === repoId) : undefined

  if (entry === undefined) {
    if (reposQuery.isLoading) return null
    return (
      <EmptyState icon={FolderGit2} message="That repository isn't registered." action={{ label: 'Open Repositories', onClick: () => void navigate({ to: ROUTE_IDS.repos }) }} className="p-6" />
    )
  }

  const ready = 'config' in entry
  const name = repoName(entry)
  const tab = search.tab ?? 'overview'

  function setTab(next: 'overview' | 'worktrees' | 'denials'): void {
    void navigate({ to: ROUTE_IDS.repo, params: { repoId }, search: { tab: next } })
  }

  async function handleRemove(): Promise<void> {
    try {
      const result = await removeMutation.mutateAsync({ id: repoId as RepoId })
      if (!result.ok) return
      queryClient.setQueryData(ipcQueryOptions('repos:list').queryKey, (): ReposListResponse => ({ ok: true, repositories: result.repositories }))
      setRemoveOpen(false)
      toast(`Removed ${name}.`)
      void navigate({ to: ROUTE_IDS.repos })
    } catch (error) {
      console.error('Failed to remove a repository', error)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-1 text-title font-semibold text-foreground">
          <button type="button" onClick={() => void navigate({ to: ROUTE_IDS.repos })} className="text-muted-foreground hover:underline">
            Repositories
          </button>
          <span className="text-muted-foreground">›</span>
          <span>{name}</span>
        </div>
        <div className="flex items-center gap-2">
          {ready ? (
            <Button variant="outline" size="small" onClick={() => startNewSession(repoId as RepoId)}>
              New session
            </Button>
          ) : null}
          <Button variant="outline" size="small" onClick={() => legacyActions()?.openSessions(repoId as RepoId)}>
            Transcripts
          </Button>
          <Button variant="outline" size="small" onClick={() => setRemoveOpen(true)}>
            Remove
          </Button>
          <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
            {removeOpen ? (
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {name} from port?</AlertDialogTitle>
                  <AlertDialogDescription>port stops reading it. The folder, its tickets and its PRs are untouched, and you can add it again.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(event) => {
                      event.preventDefault()
                      void handleRemove()
                    }}
                  >
                    Remove repository
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            ) : null}
          </AlertDialog>
        </div>
      </div>
      {ready ? (
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'overview' | 'worktrees' | 'denials')} className="flex flex-1 flex-col overflow-hidden">
          <TabsList className="mx-4 mt-2 self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="worktrees">Worktrees</TabsTrigger>
            <TabsTrigger value="denials">Denials</TabsTrigger>
          </TabsList>
          <div className="flex-1 overflow-y-auto">
            {tab === 'overview' ? <OverviewTab entry={entry} /> : null}
            {tab === 'worktrees' ? <WorktreesTab repoId={repoId as RepoId} commandsWorktrees={entry.config.commands.worktrees} /> : null}
            {tab === 'denials' ? <DenialsTab repoId={repoId as RepoId} /> : null}
          </div>
        </Tabs>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <OverviewTab entry={entry} />
        </div>
      )}
    </div>
  )
}

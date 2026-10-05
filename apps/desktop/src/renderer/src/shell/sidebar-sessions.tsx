// DESIGN §3's "Your sessions" section — live sessions, New session, History…
// (#316). Selecting or starting a session delegates to `session/controller.ts`,
// since the legacy Session screen still owns the live conversation itself.
import { useState } from 'react'
import { History, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'
import { sessionTitle } from '../../../shared/hosting/label'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import { useIpcMutation, useIpcQuery } from '../data/query'
import { selectSession, startNewSession } from '../session/controller'
import { useSelectedSession } from '../session/selection'
import { useRenaming, setRenaming } from './stores'
import { legacyActions } from './legacy-actions'

function repoTag(repos: readonly RepositoryEntry[] | undefined, repoId: RepoId): string {
  const entry = repos?.find((r) => r.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

function dotFor(session: HostedSessionSnapshot): { readonly className: string; readonly label: string } {
  if (session.pendingPermissions.length > 0) return { className: 'bg-attention-dot animate-pulse', label: 'Waiting for your permission' }
  if (session.phase === 'starting' || session.phase === 'streaming') return { className: 'bg-working-dot', label: 'Working' }
  return { className: 'bg-idle-dot', label: 'Idle' }
}

function SessionRow({ session, repos, selected }: { readonly session: HostedSessionSnapshot; readonly repos: readonly RepositoryEntry[] | undefined; readonly selected: boolean }) {
  const renaming = useRenaming()
  const rename = useIpcMutation('session:rename')
  const [draft, setDraft] = useState(() => sessionTitle(session))
  const dot = dotFor(session)
  const isRenaming = renaming === session.sessionKey

  async function commitRename(): Promise<void> {
    const title = draft.trim().slice(0, 80)
    setRenaming(null)
    if (title === '' || title === sessionTitle(session)) return
    try {
      const result = await rename.mutateAsync({ sessionKey: session.sessionKey, title })
      if (!result.ok) toast.error(`Couldn't rename the session: ${result.kind === 'rename-failed' ? result.message : result.kind}`)
    } catch {
      toast.error("Couldn't rename the session: couldn't reach the main process.")
    }
  }

  if (isRenaming) {
    return (
      <div className="flex h-7 items-center gap-1.5 px-2">
        <Input
          autoFocus
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commitRename()
            else if (event.key === 'Escape') setRenaming(null)
          }}
          className="h-6 text-small"
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => selectSession(session.sessionKey)}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-selection text-primary-text',
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dot.className)} />
        </TooltipTrigger>
        <TooltipContent>{dot.label}</TooltipContent>
      </Tooltip>
      <span className="flex-1 truncate">{sessionTitle(session)}</span>
      <span className="shrink-0 truncate text-meta text-muted-foreground">{repoTag(repos, session.repoId)}</span>
    </button>
  )
}

export function SidebarSessions() {
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const selectedKey = useSelectedSession()
  const live = (sessions.data ?? []).filter((s) => s.phase !== 'ended')
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter((r): r is Extract<RepositoryEntry, { status: 'ready' }> => 'config' in r) : []

  function handleNewSession(): void {
    const only = readyRepos.length === 1 ? readyRepos[0] : undefined
    if (only !== undefined) startNewSession(only.id)
  }

  function handleHistory(): void {
    const only = readyRepos.length === 1 ? readyRepos[0] : undefined
    if (only !== undefined) legacyActions()?.openSessions(only.id)
  }

  return (
    <div>
      <div className="px-2 py-1.5 text-meta font-medium text-muted-foreground">Your sessions</div>
      {sessions.status === 'pending' ? (
        <div className="px-2">
          <Skeleton className="h-7 w-full" />
        </div>
      ) : sessions.status === 'error' ? (
        <p className="px-2 py-1 text-small text-muted-foreground">Couldn&apos;t load your sessions.</p>
      ) : live.length === 0 ? (
        <p className="px-2 py-1 text-small text-muted-foreground">No sessions open.</p>
      ) : (
        live.map((session) => <SessionRow key={session.sessionKey} session={session} repos={repos.data?.ok === true ? repos.data.repositories : undefined} selected={session.sessionKey === selectedKey} />)
      )}

      {readyRepos.length <= 1 ? (
        <button
          type="button"
          onClick={handleNewSession}
          disabled={readyRepos.length === 0}
          title={readyRepos.length === 0 ? 'Register a repository to start a session.' : undefined}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4 shrink-0" />
          New session
        </button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Plus className="size-4 shrink-0" />
              New session
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {readyRepos.map((repo) => (
              <DropdownMenuItem key={repo.id} onSelect={() => startNewSession(repo.id)}>
                New session in {repo.config.repo}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {readyRepos.length <= 1 ? (
        <button
          type="button"
          onClick={handleHistory}
          disabled={readyRepos.length === 0}
          title={readyRepos.length === 0 ? 'Register a repository to see its history.' : undefined}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <History className="size-4 shrink-0" />
          History…
        </button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <History className="size-4 shrink-0" />
              History…
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {readyRepos.map((repo) => (
              <DropdownMenuItem key={repo.id} onSelect={() => legacyActions()?.openSessions(repo.id)}>
                Transcripts for {repo.config.repo}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

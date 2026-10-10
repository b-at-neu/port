// "Your sessions" — selecting or starting one delegates to session/actions.ts.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { History, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'
import { sessionTitle } from '../../../shared/hosting/label'
import { folderLabel } from '../../../shared/workspace/label'
import type { RepositoryEntry } from '../../../shared/repos'
import { useIpcMutation, useIpcQuery } from '../data/query'
import { useSelectedSession } from '../session/selection'
import { sidebarDotLabel } from '../session/interaction-copy'
import { useRenaming, setRenaming, openNewSessionDialog } from './stores'
import { ROUTE_IDS } from '../router/routes'

function repoTag(repos: readonly RepositoryEntry[] | undefined, session: HostedSessionSnapshot): string {
  if (session.repoId === null) return folderLabel(session.workspace.folder)
  const entry = repos?.find((r) => r.id === session.repoId)
  if (entry === undefined) return session.repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

function dotFor(session: HostedSessionSnapshot): { readonly className: string; readonly label: string } {
  const oldestInteraction = session.pendingPermissions.filter((permission) => permission.interaction !== null).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0] ?? null
  if (oldestInteraction !== null && oldestInteraction.interaction) return { className: 'bg-attention-dot animate-pulse', label: sidebarDotLabel(oldestInteraction.interaction.kind) }
  if (session.pendingPermissions.length > 0) return { className: 'bg-attention-dot animate-pulse', label: 'Waiting for your permission' }
  if (session.phase === 'starting' || session.phase === 'streaming') return { className: 'bg-working-dot', label: 'Working' }
  return { className: 'bg-idle-dot', label: 'Idle' }
}

function SessionRow({ session, repos, selected }: { readonly session: HostedSessionSnapshot; readonly repos: readonly RepositoryEntry[] | undefined; readonly selected: boolean }) {
  const navigate = useNavigate()
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
      onClick={() => void navigate({ to: ROUTE_IDS.session, search: { key: session.sessionKey } })}
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
      <span className="shrink-0 truncate text-meta text-muted-foreground">{repoTag(repos, session)}</span>
    </button>
  )
}

export function SidebarSessions() {
  const navigate = useNavigate()
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const selectedKey = useSelectedSession()
  // Stage sessions (this app's own pipeline dispatches) live in the Pipelines section, never here.
  const live = (sessions.data ?? []).filter((s) => s.phase !== 'ended' && s.stage === null)

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

      <button
        type="button"
        onClick={() => openNewSessionDialog()}
        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-4 shrink-0" />
        New session
      </button>

      <button
        type="button"
        onClick={() => void navigate({ to: ROUTE_IDS.history, search: {} })}
        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <History className="size-4 shrink-0" />
        History…
      </button>
    </div>
  )
}

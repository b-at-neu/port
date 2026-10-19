// "Your sessions" — selecting or starting one delegates to session/actions.ts.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { History, Plus } from 'lucide-react'
import { cn } from '@/renderer/lib/utils'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { IconButton } from '@/renderer/components/icon-button'
import { Input } from '@/renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { toast } from 'sonner'
import type { HostedSessionSnapshot, SessionMarks } from '@/types/hosting'
import { sessionTitle } from '@/utils/hosting/label'
import { folderLabel } from '@/utils/workspace/label'
import type { RepositoryEntry } from '@/utils/repos'
import { useIpcMutation, useIpcQuery } from '@/renderer/data/query'
import { useSelectedSession } from '@/renderer/session/selection'
import { sidebarDotLabel } from '@/renderer/session/interaction-copy'
import { useRenaming, setRenaming, openNewSessionDialog } from '@/renderer/shell/stores'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { useSessionMarks } from '@/renderer/session/marks'
import { SessionMarkMenu, SessionPinGlyph } from '@/renderer/components/session-mark-menu'
import { orderSessions } from '@/utils/shell/session-order'

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

function SessionRow({ session, repos, marks, selected }: { readonly session: HostedSessionSnapshot; readonly repos: readonly RepositoryEntry[] | undefined; readonly marks: SessionMarks | undefined; readonly selected: boolean }) {
  const navigate = useNavigate()
  const renaming = useRenaming()
  const rename = useIpcMutation('session:rename')
  const [draft, setDraft] = useState(() => sessionTitle(session))
  const dot = dotFor(session)
  const isRenaming = renaming === session.sessionKey
  const pinned = session.claudeSessionId !== null && (marks?.pinned.includes(session.claudeSessionId) ?? false)

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
          className="h-6 text-body"
        />
      </div>
    )
  }

  return (
    <div className={cn('group/row flex h-7 w-full items-center gap-1 rounded-md pr-1 text-body text-foreground-secondary', selected && 'bg-selection text-primary-text')}>
      <button
        type="button"
        onClick={() => void navigate({ to: ROUTE_IDS.session, search: { key: session.sessionKey } })}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dot.className)} />
          </TooltipTrigger>
          <TooltipContent>{dot.label}</TooltipContent>
        </Tooltip>
        {pinned ? <SessionPinGlyph /> : null}
        <span className="flex-1 truncate">{sessionTitle(session)}</span>
        <span className="shrink-0 truncate text-meta text-muted-foreground">{repoTag(repos, session)}</span>
      </button>
      <div className="shrink-0 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-has-[[data-state=open]]/row:opacity-100">
        <SessionMarkMenu sessionId={session.claudeSessionId} marks={marks} onRename={() => setRenaming(session.sessionKey)} />
      </div>
    </div>
  )
}

export function SidebarSessions() {
  const navigate = useNavigate()
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const marks = useSessionMarks()
  const selectedKey = useSelectedSession()
  const live = orderSessions(sessions.data ?? [], marks.data)

  return (
    <div>
      <div className="flex h-7 items-center gap-1 pl-2 pr-1">
        <span className="flex-1 text-meta font-medium text-muted-foreground">Your sessions</span>
        <IconButton label="New session" onClick={() => openNewSessionDialog()}>
          <Plus />
        </IconButton>
        <IconButton label="History" onClick={() => void navigate({ to: ROUTE_IDS.history, search: {} })}>
          <History />
        </IconButton>
      </div>
      {sessions.status === 'pending' ? (
        <div className="px-2">
          <Skeleton className="h-7 w-full" />
        </div>
      ) : sessions.status === 'error' ? (
        <p className="px-2 py-1 text-meta text-muted-foreground">Couldn&apos;t load your sessions.</p>
      ) : live.length === 0 ? (
        <p className="px-2 py-1 text-meta text-muted-foreground">No sessions open.</p>
      ) : (
        live.map((session) => <SessionRow key={session.sessionKey} session={session} repos={repos.data?.ok === true ? repos.data.repositories : undefined} marks={marks.data} selected={session.sessionKey === selectedKey} />)
      )}
    </div>
  )
}

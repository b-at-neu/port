// "Your sessions" — selecting or starting one delegates to session/actions.ts.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { History, Plus } from 'lucide-react'
import { cn } from '@/renderer/lib/utils'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { IconButton } from '@/renderer/components/icon-button'
import { Input } from '@/renderer/components/ui/input'
import { toast } from 'sonner'
import type { HostedSessionSnapshot, SessionMarks } from '@/types/hosting'
import { sessionTitle } from '@/utils/hosting/label'
import { folderLabel } from '@/utils/workspace/label'
import type { RepositoryEntry } from '@/utils/repos'
import { useIpcMutation, useIpcQuery } from '@/renderer/data/query'
import { isUserSessionSelected, useSidebarSelection } from '@/renderer/shell/sidebar-selection'
import { dotFor } from '@/renderer/shell/session-row-model'
import { useRenaming, setRenaming, openNewSessionDialog } from '@/renderer/shell/stores'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { useSessionMarks } from '@/renderer/session/marks'
import { SessionRow } from '@/renderer/components/session-row'
import { orderSessions } from '@/utils/shell/session-order'

function repoTag(repos: readonly RepositoryEntry[] | undefined, session: HostedSessionSnapshot): string {
  if (session.repoId === null) return folderLabel(session.workspace.folder)
  const entry = repos?.find((r) => r.id === session.repoId)
  if (entry === undefined) return session.repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

function LiveSessionEntry({ session, repos, marks, selected }: { readonly session: HostedSessionSnapshot; readonly repos: readonly RepositoryEntry[] | undefined; readonly marks: SessionMarks | undefined; readonly selected: boolean }) {
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
          className="h-6 text-body"
        />
      </div>
    )
  }

  return (
    <SessionRow
      density="sidebar"
      leading={<span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dot.className)} />}
      title={sessionTitle(session)}
      meta={repoTag(repos, session)}
      statusText={dot.label}
      tooltip={{ title: sessionTitle(session), line: dot.label }}
      selected={selected}
      onOpen={() => void navigate({ to: ROUTE_IDS.session, search: { key: session.sessionKey } })}
      marks={{ sessionId: session.claudeSessionId, marks, onRename: () => setRenaming(session.sessionKey) }}
    />
  )
}

export function SidebarSessions() {
  const navigate = useNavigate()
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const marks = useSessionMarks()
  const selection = useSidebarSelection()
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
        live.map((session) => <LiveSessionEntry key={session.sessionKey} session={session} repos={repos.data?.ok === true ? repos.data.repositories : undefined} marks={marks.data} selected={isUserSessionSelected(session.sessionKey, selection)} />)
      )}
    </div>
  )
}

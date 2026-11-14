// The operator's own session rows — one row component, and the group for sessions in no registered repo.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/renderer/lib/utils'
import { Input } from '@/renderer/components/ui/input'
import { toast } from 'sonner'
import type { HostedSessionSnapshot, SessionMarks } from '@/types/hosting'
import { sessionTitle } from '@/utils/hosting/label'
import { folderLabel } from '@/utils/workspace/label'
import { useIpcMutation } from '@/renderer/data/query'
import { isUserSessionSelected } from '@/renderer/shell/sidebar-selection'
import { dotFor } from '@/renderer/shell/session-row-model'
import { useRenaming, setRenaming } from '@/renderer/shell/stores'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { SessionRow } from '@/renderer/components/session-row'
import type { SidebarSelection } from '@/types/shell'

export function LiveSessionEntry({ session, marks, selected, meta }: { readonly session: HostedSessionSnapshot; readonly marks: SessionMarks | undefined; readonly selected: boolean; readonly meta?: string }) {
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
      meta={meta}
      statusText={dot.label}
      tooltip={{ title: sessionTitle(session), line: dot.label }}
      selected={selected}
      onOpen={() => void navigate({ to: ROUTE_IDS.session, search: { key: session.sessionKey } })}
      marks={{ sessionId: session.claudeSessionId, marks, onRename: () => setRenaming(session.sessionKey) }}
    />
  )
}

/** Sessions whose folder is in no registered repository, each tagged with its folder. */
export function OtherSessions({ sessions, marks, selection }: { readonly sessions: readonly HostedSessionSnapshot[]; readonly marks: SessionMarks | undefined; readonly selection: SidebarSelection }) {
  if (sessions.length === 0) return null
  return (
    <div>
      <div className="flex h-7 items-center px-2 text-meta font-medium text-muted-foreground">Other sessions</div>
      {sessions.map((session) => (
        <LiveSessionEntry key={session.sessionKey} session={session} marks={marks} selected={isUserSessionSelected(session.sessionKey, selection)} meta={folderLabel(session.workspace.folder)} />
      ))}
    </div>
  )
}

// The shared "…" row menu for a session: Rename (sidebar only), Pin/Unpin, Archive/Unarchive — used by the sidebar and History (DESIGN §4: "a pattern used twice").
import { useState } from 'react'
import { MoreHorizontal, Pin } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useIpcQuery } from '@/renderer/data/query'
import type { SessionKey, SessionMarks } from '@/types/hosting'
import { liveUserSession } from '@/utils/shell/session-order'
import { setSessionMark } from '@/renderer/session/marks'
import { ARCHIVE_CONFIRM_ACTION, ARCHIVE_CONFIRM_PROMPT, MENU_DISABLED_HINT, menuItemLabel, RENAME_LABEL, SESSION_ACTIONS_LABEL } from '@/renderer/session/marks-copy'
import { CLOSE_CONFIRM_NO } from '@/renderer/session/copy'

export function SessionMarkMenu({ sessionId, marks, onRename }: { readonly sessionId: string | null; readonly marks: SessionMarks | undefined; readonly onRename?: () => void }) {
  const queryClient = useQueryClient()
  const pinned = sessionId !== null && (marks?.pinned.includes(sessionId) ?? false)
  const archived = sessionId !== null && (marks?.archived.includes(sessionId) ?? false)
  const disabled = sessionId === null
  const sessions = useIpcQuery('session:list')
  const [confirmKey, setConfirmKey] = useState<SessionKey | null>(null)

  function handleArchiveSelect(): void {
    if (sessionId === null) return
    if (archived) {
      void setSessionMark(queryClient, 'archived', sessionId, false)
      return
    }
    const live = liveUserSession(sessions.data ?? [], sessionId)
    if (live === null) void setSessionMark(queryClient, 'archived', sessionId, true)
    else if (live.phase === 'streaming' || live.phase === 'interrupting') setConfirmKey(live.sessionKey)
    else void setSessionMark(queryClient, 'archived', sessionId, true, live.sessionKey)
  }

  function confirmArchive(): void {
    if (sessionId === null || confirmKey === null) return
    void setSessionMark(queryClient, 'archived', sessionId, true, confirmKey)
    setConfirmKey(null)
  }

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" data-slot="session-row-menu" aria-label={SESSION_ACTIONS_LABEL}>
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onRename !== undefined ? (
          <>
            <DropdownMenuItem onSelect={onRename}>{RENAME_LABEL}</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem disabled={disabled} onSelect={() => sessionId !== null && void setSessionMark(queryClient, 'pinned', sessionId, !pinned)}>
          {menuItemLabel('pinned', pinned)}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={handleArchiveSelect}>
          {menuItemLabel('archived', archived)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{menu}</TooltipTrigger>
        <TooltipContent>{disabled ? MENU_DISABLED_HINT : SESSION_ACTIONS_LABEL}</TooltipContent>
      </Tooltip>
      <AlertDialog open={confirmKey !== null} onOpenChange={(open) => !open && setConfirmKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ARCHIVE_CONFIRM_PROMPT}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmKey(null)}>
              {CLOSE_CONFIRM_NO}
            </Button>
            <Button variant="destructive" onClick={confirmArchive}>
              {ARCHIVE_CONFIRM_ACTION}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function SessionPinGlyph() {
  return (
    <>
      <Pin aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Pinned</span>
    </>
  )
}

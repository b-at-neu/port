// The shared row menu for a session — a "…" dropdown and a right-click menu over one item list: Rename (sidebar only), Pin/Unpin, Archive/Unarchive.
import { Fragment, useState, type ReactNode } from 'react'
import { MoreHorizontal, Pin } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { ContextMenuItem, ContextMenuSeparator } from '@/renderer/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useIpcQuery } from '@/renderer/data/query'
import type { SessionKey, SessionMarks } from '@/types/hosting'
import { liveUserSession } from '@/utils/shell/session-order'
import { setSessionMark } from '@/renderer/session/marks'
import type { SessionMarkItem } from '@/types/session'
import { sessionMarkItems } from '@/renderer/session/marks-menu-model'
import { ARCHIVE_CONFIRM_ACTION, ARCHIVE_CONFIRM_PROMPT, MENU_DISABLED_HINT, SESSION_ACTIONS_LABEL } from '@/renderer/session/marks-copy'
import { CLOSE_CONFIRM_NO } from '@/renderer/session/copy'

export interface SessionMarkMenuModel {
  readonly items: readonly SessionMarkItem[]
  readonly select: (key: SessionMarkItem['key']) => void
  readonly pinned: boolean
  readonly dialog: ReactNode
}

export function useSessionMarkMenu({ sessionId, marks, onRename }: { readonly sessionId: string | null; readonly marks: SessionMarks | undefined; readonly onRename?: () => void }): SessionMarkMenuModel {
  const queryClient = useQueryClient()
  const pinned = sessionId !== null && (marks?.pinned.includes(sessionId) ?? false)
  const archived = sessionId !== null && (marks?.archived.includes(sessionId) ?? false)
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

  function select(key: SessionMarkItem['key']): void {
    if (key === 'rename') onRename?.()
    else if (key === 'pin') {
      if (sessionId !== null) void setSessionMark(queryClient, 'pinned', sessionId, !pinned)
    } else handleArchiveSelect()
  }

  const dialog = (
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
  )

  return { items: sessionMarkItems({ sessionId, marks, canRename: onRename !== undefined }), select, pinned, dialog }
}

export function SessionMarkMenu({ items, select }: Pick<SessionMarkMenuModel, 'items' | 'select'>) {
  const disabled = items.some((item) => item.key === 'pin' && item.disabled)

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" data-slot="session-row-menu" aria-label={SESSION_ACTIONS_LABEL}>
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <MenuEntry key={item.key} item={item} select={select} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{menu}</TooltipTrigger>
      <TooltipContent>{disabled ? MENU_DISABLED_HINT : SESSION_ACTIONS_LABEL}</TooltipContent>
    </Tooltip>
  )
}

function MenuEntry({ item, select }: { readonly item: SessionMarkItem; readonly select: SessionMarkMenuModel['select'] }) {
  return (
    <>
      <DropdownMenuItem disabled={item.disabled} onSelect={() => select(item.key)}>
        {item.label}
      </DropdownMenuItem>
      {item.key === 'rename' ? <DropdownMenuSeparator /> : null}
    </>
  )
}

export function SessionMarkContextItems({ items, select }: Pick<SessionMarkMenuModel, 'items' | 'select'>) {
  return items.map((item) => (
    <Fragment key={item.key}>
      <ContextMenuItem disabled={item.disabled} onSelect={() => select(item.key)}>
        {item.label}
      </ContextMenuItem>
      {item.key === 'rename' ? <ContextMenuSeparator /> : null}
    </Fragment>
  ))
}

export function SessionPinGlyph() {
  return (
    <>
      <Pin aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Pinned</span>
    </>
  )
}

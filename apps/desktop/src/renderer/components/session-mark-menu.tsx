// The shared "…" row menu for a session: Rename (sidebar only), Pin/Unpin, Archive/Unarchive — used by the sidebar and History (DESIGN §4: "a pattern used twice").
import { MoreHorizontal, Pin } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/renderer/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { SessionMarks } from '@/types/hosting'
import { setSessionMark } from '@/renderer/session/marks'
import { MENU_DISABLED_HINT, menuItemLabel, RENAME_LABEL, SESSION_ACTIONS_LABEL } from '@/renderer/session/marks-copy'

export function SessionMarkMenu({ sessionId, marks, onRename }: { readonly sessionId: string | null; readonly marks: SessionMarks | undefined; readonly onRename?: () => void }) {
  const queryClient = useQueryClient()
  const pinned = sessionId !== null && (marks?.pinned.includes(sessionId) ?? false)
  const archived = sessionId !== null && (marks?.archived.includes(sessionId) ?? false)
  const disabled = sessionId === null

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
        <DropdownMenuItem disabled={disabled} onSelect={() => sessionId !== null && void setSessionMark(queryClient, 'archived', sessionId, !archived)}>
          {menuItemLabel('archived', archived)}
        </DropdownMenuItem>
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

export function SessionPinGlyph() {
  return (
    <>
      <Pin aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Pinned</span>
    </>
  )
}

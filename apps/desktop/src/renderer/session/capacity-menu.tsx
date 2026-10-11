// The session header's "…" menu — session limit stepper, the usage notice, and Dismiss once ended.
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIpcMutation, useIpcQuery } from '../data/query'
import { capacityLine, usageNotice } from './rail-model'
import { CAPACITY_SET_FAILED, DISMISS_BUTTON, LIMIT_STEPPER_TITLE, usageNoticeLines } from './rail-copy'

export function CapacityMenu({ onDismiss, showDismiss }: { readonly onDismiss: () => void; readonly showDismiss: boolean }) {
  const sessions = useIpcQuery('session:list')
  const capacity = useIpcQuery('session:capacity')
  const setCapacity = useIpcMutation('session:capacity:set')

  const open = (sessions.data ?? []).filter((s) => s.phase !== 'ended').length
  const limit = capacity.data?.limit ?? 4
  const ceiling = capacity.data?.ceiling ?? 8
  const notice = sessions.data !== undefined ? usageNotice(sessions.data, new Date()) : null

  async function setLimit(next: number): Promise<void> {
    try {
      await setCapacity.mutateAsync({ limit: Math.max(1, Math.min(ceiling, next)) })
    } catch {
      toast(CAPACITY_SET_FAILED)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" aria-label="Session menu">
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-small">Session limit</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="small" disabled={limit <= 1} onClick={() => void setLimit(limit - 1)}>
                    −
                  </Button>
                  <span className="w-4 text-center text-small tabular-nums">{limit}</span>
                  <Button variant="outline" size="small" disabled={limit >= ceiling} onClick={() => void setLimit(limit + 1)}>
                    +
                  </Button>
                </div>
              </TooltipTrigger>
              <TooltipContent>{LIMIT_STEPPER_TITLE}</TooltipContent>
            </Tooltip>
          </div>
          <span className="text-meta text-muted-foreground">{capacityLine(open, limit)}</span>
          {notice !== null
            ? (() => {
                const lines = usageNoticeLines(notice, new Date())
                return (
                  <div className="mt-1 flex flex-col gap-0.5 rounded-md bg-attention-pill px-2 py-1 text-meta text-attention-pill-foreground">
                    <span>{lines.main}</span>
                    <span>{lines.sub}</span>
                  </div>
                )
              })()
            : null}
        </div>
        {showDismiss ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDismiss}>{DISMISS_BUTTON}</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

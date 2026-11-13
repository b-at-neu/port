// The unprompted update UI: a sidebar card and a collapsed-rail icon, shown for an available release alone.
import { CircleArrowUp } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { noticeOf } from '@/renderer/update/model'
import { startUpdate } from '@/renderer/update/actions'
import { UPDATE_BUTTON_LABEL, updateAvailableTitle, updateRailLabel } from '@/renderer/update/copy'
import { ReleaseNotesLink } from '@/renderer/update/release-notes-link'
import { useUpdateState } from '@/renderer/update/use-update-state'

export function UpdateNotice() {
  const notice = noticeOf(useUpdateState().data)
  if (notice === null) return null
  return (
    <div role="status" data-slot="update-notice" className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <CircleArrowUp aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
        <span className="text-small tabular-nums text-foreground">{updateAvailableTitle(notice.version)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <ReleaseNotesLink href={notice.notesUrl} />
        <Button size="small" onClick={() => startUpdate(notice.release)}>
          {UPDATE_BUTTON_LABEL}
        </Button>
      </div>
    </div>
  )
}

export function UpdateRailButton() {
  const notice = noticeOf(useUpdateState().data)
  if (notice === null) return null
  const label = updateRailLabel(notice.version)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => startUpdate(notice.release)}
          aria-label={label}
          className="flex size-8 items-center justify-center rounded-md text-primary-text hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CircleArrowUp aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

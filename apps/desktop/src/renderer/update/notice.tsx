// The unprompted update UI: a sidebar card and a collapsed-rail icon, shown for an available release alone.
import { useQueryClient } from '@tanstack/react-query'
import { CircleArrowUp, CircleCheck, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { downloadViewOf, noticeOf } from '@/renderer/update/model'
import { runDownloadAction } from '@/renderer/update/actions'
import { DownloadControls } from '@/renderer/update/download-controls'
import { useUpdateDownload } from '@/renderer/update/use-update-download'
import { useUpdateState } from '@/renderer/update/use-update-state'
import type { UpdateDownloadView } from '@/types/update'

export function UpdateNotice() {
  const notice = noticeOf(useUpdateState().data)
  const download = useUpdateDownload().data
  if (notice === null) return null
  const view = downloadViewOf(notice.release, download)
  return (
    <div role="status" data-slot="update-notice" data-state={view.kind} className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <DownloadControls view={view} release={notice.release} />
    </div>
  )
}

function RailIcon({ kind }: { readonly kind: UpdateDownloadView['kind'] }) {
  if (kind === 'downloading') return <Loader2 aria-hidden="true" className="size-4 animate-spin" />
  if (kind === 'ready') return <CircleCheck aria-hidden="true" className="size-4" />
  return <CircleArrowUp aria-hidden="true" className="size-4" />
}

export function UpdateRailButton() {
  const client = useQueryClient()
  const notice = noticeOf(useUpdateState().data)
  const download = useUpdateDownload().data
  if (notice === null) return null
  const view = downloadViewOf(notice.release, download)
  const { railAction } = view
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled={railAction === null}
          onClick={() => railAction !== null && runDownloadAction(client, railAction, notice.notesUrl)}
          aria-label={view.railLabel}
          className="flex size-8 items-center justify-center rounded-md text-primary-text hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default"
        >
          <RailIcon kind={view.kind} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{view.railLabel}</TooltipContent>
    </Tooltip>
  )
}

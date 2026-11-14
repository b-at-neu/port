// One block for every download state, shared by the sidebar card and the About status line.
import { useQueryClient } from '@tanstack/react-query'
import { CircleArrowUp, CircleCheck, Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { runDownloadAction } from '@/renderer/update/actions'
import { UPDATE_DOWNLOAD_PROGRESS_LABEL } from '@/renderer/update/copy'
import { ReleaseNotesLink } from '@/renderer/update/release-notes-link'
import type { AvailableRelease, UpdateDownloadView } from '@/types/update'

function StateIcon({ kind }: { readonly kind: UpdateDownloadView['kind'] }) {
  if (kind === 'downloading') return <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-primary-text" />
  if (kind === 'ready') return <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
  return <CircleArrowUp aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
}

function ProgressBar({ percent }: { readonly percent: number | null }) {
  return (
    <div
      role="progressbar"
      aria-label={UPDATE_DOWNLOAD_PROGRESS_LABEL}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-1 w-full overflow-hidden rounded-full bg-border"
    >
      {percent !== null ? <div className="h-full rounded-full bg-primary-text" style={{ width: `${String(percent)}%` }} /> : null}
    </div>
  )
}

export function DownloadControls({ view, release }: { readonly view: UpdateDownloadView; readonly release: AvailableRelease }) {
  const client = useQueryClient()
  return (
    <div data-slot="update-download" data-state={view.kind} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <StateIcon kind={view.kind} />
        <span className="text-small tabular-nums text-foreground">{view.title}</span>
      </div>
      {view.kind === 'downloading' ? <ProgressBar percent={view.percent} /> : null}
      {view.progressText !== null ? <span className="text-meta tabular-nums text-muted-foreground">{view.progressText}</span> : null}
      {view.hint !== null ? <span className="text-meta text-foreground-secondary">{view.hint}</span> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {view.linkLabel !== null ? <ReleaseNotesLink href={release.notesUrl} label={view.linkLabel} /> : null}
        <div className="flex items-center gap-2">
          {view.buttons.map((button) => (
            <Button key={button.action} size="small" variant={button.variant} onClick={() => runDownloadAction(client, button.action, release.notesUrl)}>
              {button.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

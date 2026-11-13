// The Settings → About update status line.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { checkForUpdates, startUpdate, useUpdateCheckPending } from '@/renderer/update/actions'
import { UPDATE_BUTTON_LABEL, UPDATE_CHECK_LABEL, UPDATE_RETRY_LABEL, UPDATE_UNAVAILABLE } from '@/renderer/update/copy'
import { statusOf } from '@/renderer/update/model'
import { ReleaseNotesLink } from '@/renderer/update/release-notes-link'
import { useUpdateState } from '@/renderer/update/use-update-state'
import type { UpdateState } from '@/types/update'

function CheckedAgo({ state, ago }: { readonly state: UpdateState; readonly ago: string }) {
  if (state.kind !== 'up-to-date') return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-small text-muted-foreground">· checked {ago}</span>
      </TooltipTrigger>
      <TooltipContent>{new Date(state.checkedAt).toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}

interface StatusBodyProps {
  readonly state: UpdateState
  readonly checkPending: boolean
  readonly check: () => void
}

function StatusBody({ state, checkPending, check }: StatusBodyProps) {
  const [now] = useState(() => Date.now())
  const view = statusOf(state, now)
  const { release } = view
  const busy = checkPending || view.kind === 'checking'

  if (view.kind === 'error') {
    return (
      <div data-slot="update-status" data-state={view.kind}>
        <ErrorBanner message={view.text} action={{ label: UPDATE_RETRY_LABEL, onClick: check }} />
      </div>
    )
  }

  return (
    <div data-slot="update-status" data-state={view.kind} className="flex flex-wrap items-center gap-2">
      <span className="text-small tabular-nums text-foreground">{view.text}</span>
      {view.checkedAgo !== null ? <CheckedAgo state={state} ago={view.checkedAgo} /> : null}
      {release !== null ? <ReleaseNotesLink href={release.notesUrl} /> : null}
      {release !== null ? (
        <Button size="small" onClick={() => startUpdate(release)}>
          {UPDATE_BUTTON_LABEL}
        </Button>
      ) : null}
      {view.canCheck || view.kind === 'checking' ? (
        <Button variant="outline" size="small" disabled={busy} onClick={check}>
          {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {UPDATE_CHECK_LABEL}
        </Button>
      ) : null}
    </div>
  )
}

export function UpdateStatus() {
  const client = useQueryClient()
  const query = useUpdateState()
  const checkPending = useUpdateCheckPending()
  if (query.status === 'pending') return <Skeleton className="h-4 w-40" />
  if (query.status === 'error') return <p className="text-small text-muted-foreground">{UPDATE_UNAVAILABLE}</p>

  const { data: state } = query
  const key = state.kind === 'up-to-date' ? `${state.kind}-${state.checkedAt}` : state.kind
  return <StatusBody key={key} state={state} checkPending={checkPending} check={() => void checkForUpdates(client)} />
}

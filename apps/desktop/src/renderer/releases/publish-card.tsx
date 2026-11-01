// The ready-to-publish block: the drafted notes in an editor, and the confirmation that tags production.
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Textarea } from '@/renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { ReleaseStatus } from '@/types/release'
import { draftNotes } from '@/utils/release/changelog'
import { NOTES_EMPTY_TOOLTIP, NOTES_LABEL, publishDialogBody, publishDialogTitle, publishLabel, readyToPublishCopy } from '@/renderer/releases/copy'
import { shortOid } from '@/renderer/releases/model'

interface PublishCardProps {
  readonly status: ReleaseStatus
  readonly version: string
  readonly pending: boolean
  readonly onPublish: (notes: string) => void
}

export function PublishCard({ status, version, pending, onPublish }: PublishCardProps) {
  const [notes, setNotes] = useState(() => draftNotes(status.entries))
  const [confirming, setConfirming] = useState(false)
  const production = status.production ?? 'the production branch'
  const blank = notes.trim() === ''

  return (
    <div data-slot="publish-card" className="flex flex-col gap-2 px-4 py-2">
      <p className="text-body text-foreground">{readyToPublishCopy(version, production)}</p>
      <Textarea aria-label={NOTES_LABEL} value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-32 font-mono text-small" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="self-start">
            <Button disabled={blank || pending} onClick={() => setConfirming(true)}>
              {pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
              {publishLabel(version)}
            </Button>
          </span>
        </TooltipTrigger>
        {blank ? <TooltipContent>{NOTES_EMPTY_TOOLTIP}</TooltipContent> : null}
      </Tooltip>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-slot="alert-dialog-content">
          <AlertDialogHeader>
            <AlertDialogTitle>{publishDialogTitle(version)}</AlertDialogTitle>
            <AlertDialogDescription>{publishDialogBody(version, production, shortOid(status.productionHead ?? ''), status.postPublishHook)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                onPublish(notes)
              }}
            >
              {publishLabel(version)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

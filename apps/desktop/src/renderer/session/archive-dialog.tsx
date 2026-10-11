// The Dismiss confirmation for an ended worktree session — keep/remove/force (DESIGN "Archive (Dismiss)").
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'
import { dismiss } from './actions'
import { ARCHIVE_DIALOG_TITLE, ARCHIVE_DIRTY_BODY, ARCHIVE_KEEP, ARCHIVE_REMOVE, ARCHIVE_REMOVE_ANYWAY, ARCHIVE_UNREACHABLE_TOAST, archiveBody, archiveRemoveFailedToast } from './copy'

export function ArchiveDialog({ snapshot, open, onOpenChange }: { readonly snapshot: HostedSessionSnapshot; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const worktree = snapshot.workspace.worktree

  async function run(choice: 'keep' | 'remove' | 'force'): Promise<void> {
    setPending(true)
    const result = await dismiss(snapshot.sessionKey, choice)
    setPending(false)
    if (result === 'unreachable') {
      toast(ARCHIVE_UNREACHABLE_TOAST)
      return
    }
    if (result.ok) {
      onOpenChange(false)
      return
    }
    if (result.kind === 'worktree-dirty') {
      setDirty(true)
      return
    }
    if (result.kind === 'worktree-remove-failed') {
      toast(archiveRemoveFailedToast(result.message))
      onOpenChange(false)
    }
  }

  if (worktree === null) return null

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent data-slot="archive-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{ARCHIVE_DIALOG_TITLE}</AlertDialogTitle>
        </AlertDialogHeader>
        <p className="text-small text-muted-foreground">{dirty ? ARCHIVE_DIRTY_BODY : archiveBody(worktree.path, worktree.branch)}</p>
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => void run('keep')}>
            {ARCHIVE_KEEP}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => void run(dirty ? 'force' : 'remove')}>
            {dirty ? ARCHIVE_REMOVE_ANYWAY : ARCHIVE_REMOVE}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

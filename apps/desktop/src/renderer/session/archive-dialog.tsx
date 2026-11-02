// The Dismiss confirmation for an ended worktree session — keep/remove/force (DESIGN "Archive (Dismiss)").
import { useState } from 'react'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import type { HostedSessionSnapshot, SessionDismissResult } from '@/types/hosting'
import type { ActionToast } from '@/types/toast'
import { runInBackground, UNREACHABLE } from '@/renderer/lib/background-action'
import { dismiss } from '@/renderer/session/actions'
import { ARCHIVE_DIALOG_TITLE, ARCHIVE_DIRTY_BODY, ARCHIVE_KEEP, ARCHIVE_PENDING, ARCHIVE_REMOVE, ARCHIVE_REMOVE_ANYWAY, ARCHIVE_UNAVAILABLE, archiveBody, archiveRemoveFailedToast, archiveSuccessToast } from '@/renderer/session/copy'

type Choice = 'keep' | 'remove' | 'force'

function toastFor(result: SessionDismissResult, choice: Choice): ActionToast | null {
  if (result.ok) return { tone: 'success', title: archiveSuccessToast(choice), description: null, action: null, cancel: null }
  if (result.kind === 'worktree-dirty') return null
  const title = result.kind === 'worktree-remove-failed' ? archiveRemoveFailedToast(result.message) : ARCHIVE_UNAVAILABLE
  return { tone: 'error', title, description: null, action: null, cancel: null }
}

export function ArchiveDialog({ snapshot, open, onOpenChange }: { readonly snapshot: HostedSessionSnapshot; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [dirty, setDirty] = useState(false)
  const worktree = snapshot.workspace.worktree

  async function run(choice: Choice): Promise<void> {
    onOpenChange(false)
    const result = await runInBackground({ id: `session-dismiss:${snapshot.sessionKey}`, pending: ARCHIVE_PENDING, run: () => dismiss(snapshot.sessionKey, choice), toToast: (outcome) => (outcome === 'unreachable' ? UNREACHABLE : toastFor(outcome, choice)) })
    if (result === 'unreachable' || result.ok || result.kind !== 'worktree-dirty') return
    setDirty(true)
    onOpenChange(true)
  }

  if (worktree === null) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-slot="archive-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{ARCHIVE_DIALOG_TITLE}</AlertDialogTitle>
        </AlertDialogHeader>
        <p className="text-small text-muted-foreground">{dirty ? ARCHIVE_DIRTY_BODY : archiveBody(worktree.path, worktree.branch)}</p>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void run('keep')}>
            {ARCHIVE_KEEP}
          </Button>
          <Button variant="destructive" onClick={() => void run(dirty ? 'force' : 'remove')}>
            {dirty ? ARCHIVE_REMOVE_ANYWAY : ARCHIVE_REMOVE}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

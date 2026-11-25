// The Dismiss confirmation for an ended worktree session — keep/remove/force (DESIGN "Archive (Dismiss)").
import { useState } from 'react'
import { ConfirmDialog } from '@/renderer/components/confirm-dialog'
import type { HostedSessionSnapshot, WorktreeChoice } from '@/types/hosting'
import { useDismissSession } from '@/renderer/session/actions'
import { ARCHIVE_DIALOG_TITLE, ARCHIVE_DIRTY_BODY, ARCHIVE_KEEP, ARCHIVE_REMOVE, ARCHIVE_REMOVE_ANYWAY, archiveBody } from '@/renderer/session/copy'

export function ArchiveDialog({ snapshot, open, onOpenChange }: { readonly snapshot: HostedSessionSnapshot; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [dirty, setDirty] = useState(false)
  const { dismiss } = useDismissSession()
  const worktree = snapshot.workspace.worktree

  async function run(choice: WorktreeChoice): Promise<void> {
    onOpenChange(false)
    const result = await dismiss(snapshot.sessionKey, choice)
    if (result === 'unreachable' || result.ok || result.kind !== 'worktree-dirty') return
    setDirty(true)
    onOpenChange(true)
  }

  if (worktree === null) return null

  return (
    <ConfirmDialog
      open={open}
      title={ARCHIVE_DIALOG_TITLE}
      description={dirty ? ARCHIVE_DIRTY_BODY : archiveBody(worktree.path, worktree.branch)}
      secondary={{ label: ARCHIVE_KEEP, onSelect: () => void run('keep') }}
      confirmLabel={dirty ? ARCHIVE_REMOVE_ANYWAY : ARCHIVE_REMOVE}
      onConfirm={() => void run(dirty ? 'force' : 'remove')}
      onCancel={() => onOpenChange(false)}
    />
  )
}

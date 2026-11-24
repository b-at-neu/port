// Which forced reclaim a worktree row offers, and the confirm and toast each write shows. Pure, no DOM.
import type { ConfirmSpec } from '@/renderer/components/confirm-dialog'
import type { ForcedFlags, InspectedWorktree, WorktreesPurgeResult, WorktreesReclaimResult } from '@/types/reclaimer'
import type { ActionToast } from '@/types/toast'
import {
  forcedConfirmLabel,
  forcedDialogBody,
  forcedDialogIsDestructive,
  forcedDialogTitle,
  forcedReclaimToast,
  PURGE_CONFIRM_LABEL,
  PURGE_DIALOG_BODY,
  purgeDialogTitle,
  purgeResultToast,
  RECLAIM_CONFIRM_LABEL,
  RECLAIM_DIALOG_BODY,
  reclaimDialogTitle,
  reclaimFailureToast,
  reclaimResultToast,
} from '@/renderer/repositories/worktrees-copy'

interface ForcedRequest extends ForcedFlags {
  readonly path: string
}

// Only decides which button to show — the run re-classifies the path, and an unknown dirty count counts as dirty.
export function forcedReclaimFor(worktree: InspectedWorktree): ForcedFlags | null {
  if (!worktree.otherwiseReclaimable) return null
  if (worktree.state === 'locked') return { unlock: true, forceDirty: worktree.dirtyFiles !== 0 }
  if (worktree.state === 'dirty') return { unlock: false, forceDirty: true }
  return null
}

export function orphanName(dir: string): string {
  return dir.split(/[\\/]/).filter((part) => part !== '').pop() ?? dir
}

function nameOfIssue(worktrees: readonly InspectedWorktree[], issue: number): string | null {
  return worktrees.find((w) => w.issue === issue)?.pathBasename ?? null
}

/** `issue` null reclaims every reclaimable worktree. */
export function reclaimConfirm(worktrees: readonly InspectedWorktree[], issue: number | null): ConfirmSpec {
  const count = issue === null ? worktrees.filter((w) => w.reclaimable).length : 1
  const singleName = issue === null ? null : nameOfIssue(worktrees, issue)
  return { title: reclaimDialogTitle(count, singleName), description: RECLAIM_DIALOG_BODY, confirmLabel: RECLAIM_CONFIRM_LABEL, tone: 'destructive' }
}

export function reclaimPending(worktrees: readonly InspectedWorktree[], issue: number | null): string {
  const name = issue === null ? null : nameOfIssue(worktrees, issue)
  return name === null ? 'Reclaiming worktrees…' : `Reclaiming ${name}…`
}

/** Destructive only when the run discards uncommitted changes. */
export function forcedConfirm(worktrees: readonly InspectedWorktree[], force: ForcedRequest | null): ConfirmSpec {
  if (force === null) return reclaimConfirm(worktrees, null)
  const worktree = worktrees.find((w) => w.path === force.path)
  const name = worktree?.pathBasename ?? orphanName(force.path)
  const dirtyFiles = worktree?.dirtyFiles ?? 0
  return {
    title: forcedDialogTitle(name, force, dirtyFiles),
    description: forcedDialogBody(name, force, dirtyFiles),
    confirmLabel: forcedConfirmLabel(force),
    tone: forcedDialogIsDestructive(force) ? 'destructive' : 'default',
  }
}

function forcedName(force: ForcedRequest | null): string {
  return force === null ? 'worktree' : orphanName(force.path)
}

export function forcedPending(force: ForcedRequest | null): string {
  return `Reclaiming ${forcedName(force)}…`
}

export function purgeConfirm(path: string): ConfirmSpec {
  return { title: purgeDialogTitle(orphanName(path)), description: PURGE_DIALOG_BODY, confirmLabel: PURGE_CONFIRM_LABEL, tone: 'destructive' }
}

export function purgePending(path: string): string {
  return `Deleting ${orphanName(path)}…`
}

function toast(tone: 'success' | 'error', title: string): ActionToast {
  return { tone, title, description: null, action: null, cancel: null }
}

export function reclaimToast(result: WorktreesReclaimResult): ActionToast {
  return result.ok ? toast('success', reclaimResultToast(result)) : toast('error', reclaimFailureToast(result))
}

export function forcedToast(force: ForcedRequest | null, result: WorktreesReclaimResult): ActionToast {
  return result.ok ? toast('success', forcedReclaimToast(forcedName(force), result)) : toast('error', reclaimFailureToast(result))
}

export function purgeToast(result: WorktreesPurgeResult): ActionToast {
  return result.ok ? toast('success', purgeResultToast(result)) : toast('error', reclaimFailureToast(result))
}

// Every Needs you write, each on `useActionMutation`, plus the dialogs they open.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { NeedsYouItem } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { TickContention } from '@/types/tick'
import type { ConfirmSpec } from '@/renderer/components/confirm-dialog'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { ipcQueryOptions } from '@/renderer/data/query'
import { showActionToast } from '@/renderer/lib/background-action'
import { needsYouItems } from '@/renderer/board/needs-you'
import { openDecision } from '@/renderer/decision/controller'
import { openReviewDialog } from '@/renderer/gate/controller'
import { openSession } from '@/renderer/app/navigation'
import { AllowDialog } from '@/renderer/needs-you/allow-dialog'
import type { AllowTarget } from '@/renderer/needs-you/allow-dialog'
import {
  ALLOW_DISMISS_PENDING,
  ALLOW_PENDING,
  FORCE_CONFIRM_LABEL,
  FORCE_DISPATCH_WARNING,
  PROTECTED_EDIT_DENY_MESSAGE,
  copiedPathToast,
  copyPathFailedToast,
  forceDispatchLead,
  forceDispatchPending,
  forceDispatchTitle,
  restartPending,
} from '@/renderer/needs-you/copy'
import { dismissedKeys, visibleItems } from '@/renderer/needs-you/dismissed'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'
import {
  allowToastOf,
  approvalToastOf,
  dismissedDenialToast,
  findHeld,
  findInterrupted,
  forceDispatchToastOf,
  intentOf,
  labelActionToastOf,
  refreshedToastOf,
  restartConfirm,
  restartToastOf,
  resumeAllDoneToast,
  resumeAllStep,
  resumeToastOf,
  secondaryIntentOf,
} from '@/renderer/needs-you/model'
import type { NeedsYouIntent, ResumeTally } from '@/renderer/needs-you/model'

function openUrl(url: string): void {
  window.open(url, '_blank')
}

function forceDispatchConfirm(number: number, contention: TickContention | null): ConfirmSpec {
  return {
    title: forceDispatchTitle(number),
    confirmLabel: FORCE_CONFIRM_LABEL,
    tone: 'destructive',
    description:
      contention === null ? undefined : (
        <>
          <p>{forceDispatchLead(number, contention.paths.length, contention.blocker, contention.blockerStage)}</p>
          <ul className="list-inside list-disc">
            {contention.paths.map((path) => (
              <li key={path} className="font-mono">
                {path}
              </li>
            ))}
          </ul>
          <p>{FORCE_DISPATCH_WARNING}</p>
        </>
      ),
  }
}

export function useNeedsYouActions(items: readonly NeedsYouItem[]) {
  const client = useQueryClient()
  const [allowTarget, setAllowTarget] = useState<AllowTarget | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const sessionListKey = ipcQueryOptions('session.list').queryKey

  const board = useActionMutation('board.refresh', {
    onResult: (fresh) => client.setQueryData(ipcQueryOptions('board.snapshot').queryKey, fresh),
  })

  async function refresh({ announce }: { readonly announce: boolean }): Promise<void> {
    const fresh = await board.perform({})
    if (fresh === 'unreachable') return
    await client.refetchQueries({ queryKey: sessionListKey })
    if (!announce) return
    const sessions = client.getQueryData<readonly HostedSessionSnapshot[]>(sessionListKey) ?? []
    showActionToast('board.refresh', refreshedToastOf(visibleItems(needsYouItems(fresh, new Date(), sessions), dismissedKeys()).length))
  }

  const restart = useActionMutation('stage.restart', {
    confirm: ({ id }) => restartConfirm(findInterrupted(items, id)),
    toast: {
      pending: ({ id }) => restartPending(findInterrupted(items, id)?.number ?? null),
      id: ({ id }) => `restart:${id}`,
      result: (result, { id }) => restartToastOf(findInterrupted(items, id)?.number ?? null, result),
    },
    invalidates: ['board.snapshot'],
  })

  const force = useActionMutation('held.forceDispatch', {
    confirm: ({ repoId, number }) => forceDispatchConfirm(number, findHeld(items, repoId, number)?.held.contention ?? null),
    toast: {
      pending: ({ number }) => forceDispatchPending(number),
      id: ({ repoId, number }) => `force-dispatch:${repoId}:${String(number)}`,
      result: (result, { number }) => forceDispatchToastOf(number, result),
    },
    invalidates: ['board.snapshot'],
  })

  const allow = useActionMutation('stage.allow', {
    toast: {
      pending: ALLOW_PENDING,
      id: ({ repoId, denialId }) => `allow:${repoId}:${denialId}`,
      result: (result, { rule }) => allowToastOf(rule, result, openUrl),
    },
    invalidates: ['board.snapshot'],
  })

  const dismissDenial = useActionMutation('stage.dismissDenial', {
    toast: {
      pending: ALLOW_DISMISS_PENDING,
      id: ({ repoId, denialId }) => `allow-dismiss:${repoId}:${denialId}`,
      result: () => dismissedDenialToast(),
    },
  })

  const answerEdit = useActionMutation('session.permissionAnswer')
  const resume = useActionMutation('stage.resume')
  const labelAction = useActionMutation('item.action')

  async function approve(intent: Extract<NeedsYouIntent, { readonly kind: 'approve' }>): Promise<void> {
    const { sessionKey, permissionId, decision, path } = intent
    const result = await answerEdit.perform({ sessionKey, permissionId, decision, message: decision === 'deny' ? PROTECTED_EDIT_DENY_MESSAGE : null })
    if (result !== 'unreachable') showActionToast('session.permissionAnswer', approvalToastOf(decision, path, result))
    void refresh({ announce: false })
  }

  async function resumeOne(id: string, number: number): Promise<void> {
    const result = await resume.perform({ id })
    if (result !== 'unreachable') showActionToast('stage.resume', resumeToastOf(number, result))
    void refresh({ announce: false })
  }

  async function resumeAll(entries: readonly { readonly id: string; readonly number: number }[]): Promise<void> {
    let tally: ResumeTally = { resumed: 0, attempted: 0, total: entries.length }
    for (const entry of entries) {
      const result = await resume.perform({ id: entry.id })
      if (result === 'unreachable') {
        void refresh({ announce: false })
        return
      }
      const step = resumeAllStep(tally, result, entry.number)
      if (step.kind === 'stop') {
        showActionToast('stage.resume', step.toast)
        void refresh({ announce: false })
        return
      }
      tally = step.tally
    }
    showActionToast('stage.resume', resumeAllDoneToast(tally))
    void refresh({ announce: false })
  }

  async function runLabel(key: string, intent: Extract<NeedsYouIntent, { readonly kind: 'label' }>): Promise<void> {
    setPendingKey(key)
    const result = await labelAction.perform(intent.input)
    setPendingKey((current) => (current === key ? null : current))
    if (result !== 'unreachable') showActionToast('item.action', labelActionToastOf(intent.action, intent.shown, result))
    void refresh({ announce: false })
  }

  async function copyPath(path: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path)
      toast(copiedPathToast(label))
    } catch (error) {
      console.error('Failed to copy the worktree path', error)
      toast(copyPathFailedToast(path))
    }
  }

  function dispatch(intent: NeedsYouIntent | null, key: string): void {
    if (intent === null) return
    switch (intent.kind) {
      case 'url':
        openUrl(intent.url)
        return
      case 'session':
        openSession(intent.sessionKey)
        return
      case 'review-plan':
        openReviewDialog(intent.repoId, intent.number)
        return
      case 'decision':
        openDecision(intent.request)
        return
      case 'expand':
        return
      case 'allow':
        setAllowTarget({ repoId: intent.repoId, denial: intent.denial })
        return
      case 'approve':
        void approve(intent)
        return
      case 'resume':
        void resumeOne(intent.id, intent.number)
        return
      case 'resume-all':
        void resumeAll(intent.entries)
        return
      case 'restart':
        restart.request({ id: intent.id })
        return
      case 'copy-path':
        void copyPath(intent.path, intent.label)
        return
      case 'force':
        force.request({ repoId: intent.repoId, number: intent.number })
        return
      case 'label':
        void runLabel(key, intent)
    }
  }

  const dialogs = (
    <>
      {restart.confirmDialog}
      {force.confirmDialog}
      {allowTarget === null ? null : (
        <AllowDialog
          key={allowTarget.denial.id}
          target={allowTarget}
          onAllow={({ repoId, denial }, rule) => void allow.perform({ repoId, denialId: denial.id, rule })}
          onDismiss={({ repoId, denial }) => void dismissDenial.perform({ repoId, denialId: denial.id })}
          onClose={() => setAllowTarget(null)}
        />
      )}
    </>
  )

  return {
    run: (item: NeedsYouItem) => dispatch(intentOf(item), dismissKeyOf(item)),
    runSecondary: (item: NeedsYouItem) => dispatch(secondaryIntentOf(item), dismissKeyOf(item)),
    refresh,
    refreshing: board.pending,
    pendingKey,
    dialogs,
  }
}

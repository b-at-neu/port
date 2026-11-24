// Work on's claim flow: preflight, an optional take-over question, then the write, reported as one toast per row.
import { useState } from 'react'
import { toast } from 'sonner'
import { useAction } from '@/renderer/actions/use-action'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { runInBackground } from '@/renderer/lib/background-action'
import { CLAIM_LEAVE_IT, CLAIM_TAKE_OVER, claimingCopy, takingOverCopy } from '@/renderer/claim/copy'
import { afterApply, afterPreflight, isClaimed, workOnToastId } from '@/renderer/claim/work-on'
import type { WorkOnStep } from '@/renderer/claim/work-on'
import { rowKey } from '@/renderer/backlog/sections'
import type { BacklogRowView } from '@/types/backlog'
import type { ClaimToast, PlanGateChoice } from '@/types/claim'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { ActionToast } from '@/types/toast'

type ApplyStep = Exclude<WorkOnStep, { kind: 'stop' }>

function plain(result: ClaimToast): ActionToast {
  return { ...result, action: null, cancel: null }
}

export function useWorkOn() {
  const preflight = useAction('claim.preflight')
  const refresh = useAction('board.refresh')
  const claim = useActionMutation('claim.apply', { invalidates: ['backlog.list'] })
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())

  function setPending(key: string, pending: boolean): void {
    setPendingKeys((previous) => {
      const next = new Set(previous)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
  }

  async function dispatchStatusOf(row: BacklogRowView): Promise<RepoDispatchStatus | undefined> {
    try {
      const snapshot = await refresh.run({ repoId: row.repoId, source: 'github' })
      return snapshot.dispatch.find((entry) => entry.repoId === row.repoId)
    } catch (error) {
      console.error('Failed to refresh the board after a claim', error)
      return undefined
    }
  }

  async function applyStep(row: BacklogRowView, planGate: PlanGateChoice, step: ApplyStep, takeOver: boolean): Promise<void> {
    const { repoId, repo, number } = row
    await runInBackground({
      id: workOnToastId(repoId, number),
      pending: takeOver ? takingOverCopy(number) : claimingCopy(number),
      run: async () => {
        const response = await claim.perform({ repoId, number, planGate, confirmedAssignees: step.confirmedAssignees })
        if (response === 'unreachable') return 'unreachable' as const
        const status = isClaimed(response) ? await dispatchStatusOf(row) : undefined
        return { response, status }
      },
      toToast: (result) => (result === 'unreachable' ? null : plain(afterApply({ repo, number, verdict: step.verdict, response: result.response, status: result.status, now: new Date() }))),
    })
  }

  function askTakeOver(row: BacklogRowView, planGate: PlanGateChoice, step: Extract<WorkOnStep, { kind: 'ask-take-over' }>): void {
    toast.info(step.prompt.title, {
      id: workOnToastId(row.repoId, row.number),
      description: step.prompt.description,
      duration: Infinity,
      action: {
        label: CLAIM_TAKE_OVER,
        onClick: (event) => {
          event.preventDefault()
          void applyStep(row, planGate, step, true)
        },
      },
      cancel: { label: CLAIM_LEAVE_IT, onClick: () => undefined },
    })
  }

  async function claimRow(row: BacklogRowView, planGate: PlanGateChoice): Promise<void> {
    const { repoId, repo, number } = row
    const step = await runInBackground({
      id: workOnToastId(repoId, number),
      pending: claimingCopy(number),
      run: async () => afterPreflight(repo, number, await preflight.run({ repoId, number })),
      toToast: (next) => (next.kind === 'stop' ? plain(next.toast) : null),
    })
    if (step === 'unreachable' || step.kind === 'stop') return
    if (step.kind === 'apply') await applyStep(row, planGate, step, false)
    else askTakeOver(row, planGate, step)
  }

  function start(row: BacklogRowView, planGate: PlanGateChoice): void {
    const key = rowKey(row.repoId, row.number)
    setPending(key, true)
    void claimRow(row, planGate).finally(() => setPending(key, false))
  }

  return { start, pendingKeys }
}

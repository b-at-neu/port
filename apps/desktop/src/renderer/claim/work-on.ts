// Work on's claim: preflight, then write at once, reporting every outcome as one toast per row.
import { toast } from 'sonner'
import { invoke } from '@/renderer/data/invoke'
import { applyResponseToast, claimedToast, preflightToast, takeOverPrompt, unreachableToast } from '@/renderer/claim/copy'
import type { ClaimApplyResponse, ClaimPreflightResponse, ClaimToast, ClaimVerdict, PlanGateChoice } from '@/types/claim'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { RepoId } from '@/utils/repos'

interface WorkOnParams {
  readonly repoId: RepoId
  readonly repo: string
  readonly number: number
  readonly planGate: PlanGateChoice
  /** Fires once, on an `applied` or `no-op` write. */
  readonly onClaimed: () => void
}

interface ApplyParams extends WorkOnParams {
  readonly confirmedAssignees: readonly string[]
  readonly verdict: Extract<ClaimVerdict, { kind: 'claimable' }>
  readonly takeOver: boolean
}

// A toast reusing an id merges over the previous one, so a stale take-over prompt's buttons and lifetime are cleared explicitly.
const FRESH = { action: undefined, cancel: undefined, duration: undefined } as const

function toastId(repoId: RepoId, number: number): string {
  return `work-on:${repoId}:${String(number)}`
}

function show(id: string, result: ClaimToast): void {
  const options = { ...FRESH, id, description: result.description ?? undefined }
  if (result.tone === 'success') toast.success(result.title, options)
  else toast.error(result.title, options)
}

async function dispatchStatusOf(repoId: RepoId): Promise<RepoDispatchStatus | undefined> {
  try {
    const snapshot = await invoke('board:refresh', { repoId, source: 'github' })
    return snapshot.dispatch.find((row) => row.repoId === repoId)
  } catch (error) {
    console.error('Failed to refresh the board after a claim', error)
    return undefined
  }
}

async function apply(params: ApplyParams): Promise<void> {
  const { repoId, repo, number, planGate, confirmedAssignees, verdict, takeOver, onClaimed } = params
  const id = toastId(repoId, number)
  if (takeOver) toast.loading(`Taking over #${String(number)}…`, { ...FRESH, id, description: undefined })
  let response: ClaimApplyResponse
  try {
    response = await invoke('claim:apply', { repoId, number, planGate, confirmedAssignees })
  } catch (error) {
    console.error('Failed to reach the main process while applying a claim', error)
    show(id, unreachableToast())
    return
  }
  if (response.kind !== 'write' || (response.outcome.kind !== 'applied' && response.outcome.kind !== 'no-op')) {
    show(id, applyResponseToast(repo, number, response))
    return
  }
  onClaimed()
  const status = await dispatchStatusOf(repoId)
  show(id, response.outcome.kind === 'applied' ? claimedToast({ repo, number, verdict, status }) : applyResponseToast(repo, number, response))
}

/** Resolves after the preflight and, unless a take-over is pending, after the write. */
export async function workOn(params: WorkOnParams): Promise<void> {
  const { repoId, repo, number } = params
  const id = toastId(repoId, number)
  let response: ClaimPreflightResponse
  try {
    response = await invoke('claim:preflight', { repoId, number })
  } catch (error) {
    console.error('Failed to reach the main process while reading a claim preflight', error)
    show(id, unreachableToast())
    return
  }
  if (response.kind !== 'resolved') {
    show(id, preflightToast(repo, number, response))
    return
  }
  const { preflight, verdict } = response
  if (verdict.kind !== 'claimable') {
    show(id, preflightToast(repo, number, { kind: 'refused', verdict }))
    return
  }
  const confirmedAssignees = preflight.assignees
  if (verdict.assigneeSituation === 'others') {
    const prompt = takeOverPrompt(number, verdict.others)
    toast.info(prompt.title, {
      id,
      description: prompt.description,
      duration: Infinity,
      action: {
        label: 'Take over',
        onClick: (event) => {
          event.preventDefault()
          void apply({ ...params, confirmedAssignees, verdict, takeOver: true })
        },
      },
      cancel: { label: 'Leave it', onClick: () => undefined },
    })
    return
  }
  await apply({ ...params, confirmedAssignees, verdict, takeOver: false })
}

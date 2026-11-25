import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { openReviewDialog } from '@/renderer/gate/controller'
import { resultCopy } from '@/renderer/gate/copy'
import type { GatePreflight } from '@/types/gate'
import type { ActionInput } from '@/types/ipc'
import type { ActionToast } from '@/types/toast'
import type { OwnershipSummary } from '@/types/writes'
import type { RepoId } from '@/utils/repos'

type AnswerInput = ActionInput<'gate.answer'>
type Answer = ReturnType<typeof useActionMutation<'gate.answer'>>

interface AnswerGateParams {
  readonly repoId: RepoId
  readonly preflight: GatePreflight
  readonly ownership: OwnershipSummary
}

export function useAnswerGate({ repoId, preflight, ownership }: AnswerGateParams) {
  const refresh = useActionMutation('board.refresh')
  const answer: Answer = useActionMutation('gate.answer', {
    invalidates: ['gate.preflight'],
    toast: {
      id: (input) => `gate:${input.repoId}:${String(input.number)}`,
      pending: (input) => (input.decision === 'approve' ? `Approving #${String(input.number)}…` : `Requesting changes on #${String(input.number)}…`),
      result: (response, input): ActionToast => {
        const copy = resultCopy({ number: preflight.number, decision: input.decision, response, sessionRequired: preflight.sessionRequired, ownership })
        const retryLabel = { label: 'Retry the label change', onClick: () => void answer.perform({ ...input, feedback: null, skipComment: true }) }
        const tryAgain = { label: 'Try again', onClick: () => void answer.perform({ ...input, skipComment: false }) }
        const showState = { label: 'Show current state', onClick: () => openReviewDialog(repoId, preflight.number) }
        const action = copy.actions.includes('retry-label') ? retryLabel : copy.actions.includes('try-again') ? tryAgain : null
        const cancel = copy.actions.includes('show-state') ? showState : null
        return { tone: copy.tone, title: copy.line, description: copy.note === null || copy.note === '' ? null : copy.note, action, cancel }
      },
    },
    onResult: (response) => {
      if (response.kind === 'answered' && response.labels.kind === 'applied') void refresh.perform({ repoId, source: 'github' })
    },
  })
  return { perform: (input: AnswerInput) => answer.perform(input) }
}

import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { decisionResultCopy } from '@/renderer/decision/copy'
import type { OperatorDecision, UnblockRoute } from '@/types/actions'
import type { ActionInput } from '@/types/ipc'
import type { ActionToast } from '@/types/toast'

type Decide = ReturnType<typeof useActionMutation<'item.decide'>>

function pendingLine(decision: OperatorDecision, route: UnblockRoute | null, number: number): string {
  if (decision === 'revise') return `Sending PR #${String(number)} back…`
  if (decision === 'grant') return `Granting PR #${String(number)} one more cycle…`
  return `Unblocking ${route === 'implementation' ? '#' : 'PR #'}${String(number)}…`
}

export function useDecideItem({ cap }: { readonly cap?: number }) {
  const refresh = useActionMutation('board.refresh')
  const decide: Decide = useActionMutation('item.decide', {
    toast: {
      id: (input) => `decision:${input.repoId}:${String(input.number)}`,
      pending: (input) => pendingLine(input.decision, input.route, input.number),
      result: (response, input): ActionToast => {
        const copy = decisionResultCopy({ number: input.number, decision: input.decision, route: input.route, picks: input.picks, response, cap })
        const swapLabelsOnly = { label: 'Swap labels only', onClick: () => void decide.perform({ ...input, skipComment: true }) }
        return { tone: copy.tone, title: copy.line, description: copy.note, action: copy.offerLabelOnly ? swapLabelsOnly : null, cancel: null }
      },
    },
    onResult: (response, input) => {
      if (response.ok && (response.labels.kind === 'applied' || response.labels.kind === 'no-op')) void refresh.perform({ repoId: input.repoId, source: 'github' })
    },
  })
  return { perform: (input: ActionInput<'item.decide'>) => decide.perform(input) }
}

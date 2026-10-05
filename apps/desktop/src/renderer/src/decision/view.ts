// The decision dialog's DOM — a native <dialog>, the same idiom
// `gate/view.ts`/`claim/view.ts` establish. Plain DOM only.
import { reviseNoteProblem } from '../../../shared/actions/decide'
import type { DecisionState } from './controller'
import { decisionResultCopy, dialogTitle, reviseConsequence, reviseNoteHint, unblockCapNote, unblockConsequence, unblockReasonLine } from './copy'

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(label: string, action: string, className = 'decision-dialog__button'): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.textContent = label
  node.dataset.action = action
  return node
}

function buildConfirmUnblockStep(state: Extract<DecisionState, { readonly step: 'confirm-unblock' }>): HTMLElement {
  const step = el('div', 'decision-dialog__step')
  step.appendChild(el('h2', 'decision-dialog__title', dialogTitle('unblock', state.number)))
  step.appendChild(el('p', 'decision-dialog__hint', unblockReasonLine(state.context)))
  step.appendChild(el('p', 'decision-dialog__note', unblockConsequence()))

  const capNote = unblockCapNote(state.context)
  if (capNote !== null) step.appendChild(el('p', 'decision-dialog__warning', capNote))

  const actions = el('div', 'decision-dialog__actions')
  actions.appendChild(button('Send to revision', 'decision-unblock-revision', 'decision-dialog__button decision-dialog__button--primary'))
  actions.appendChild(button('Send to review', 'decision-unblock-review'))
  actions.appendChild(button('Cancel', 'decision-cancel'))
  step.appendChild(actions)
  return step
}

function buildConfirmReviseStep(state: Extract<DecisionState, { readonly step: 'confirm-revise' }>): HTMLElement {
  const step = el('div', 'decision-dialog__step')
  step.appendChild(el('h2', 'decision-dialog__title', dialogTitle('revise', state.number)))
  step.appendChild(el('p', 'decision-dialog__note', reviseConsequence(state.context)))

  const label = el('label', 'decision-dialog__field')
  label.appendChild(el('span', 'decision-dialog__label', 'What should change?'))
  const textarea = document.createElement('textarea')
  textarea.className = 'decision-dialog__textarea'
  textarea.dataset.field = 'note'
  textarea.value = state.text
  label.appendChild(textarea)
  step.appendChild(label)

  const problem = reviseNoteProblem(state.text, state.context.headRefOid)
  const hint = reviseNoteHint(problem)
  if (hint !== null) step.appendChild(el('p', 'decision-dialog__hint', hint))

  const actions = el('div', 'decision-dialog__actions')
  const submit = button('Send back to revision', 'decision-revise-submit', 'decision-dialog__button decision-dialog__button--primary')
  submit.disabled = problem !== null
  actions.appendChild(submit)
  actions.appendChild(button('Cancel', 'decision-cancel'))
  step.appendChild(actions)
  return step
}

function buildApplyingStep(decision: 'unblock' | 'revise'): HTMLElement {
  const step = el('div', 'decision-dialog__step')
  step.appendChild(el('p', 'decision-dialog__hint', decision === 'unblock' ? 'Unblocking…' : 'Sending back…'))
  return step
}

function buildResultStep(state: Extract<DecisionState, { readonly step: 'result' }>): HTMLElement {
  const step = el('div', 'decision-dialog__step')
  const copy = decisionResultCopy({ number: state.number, decision: state.decision, route: state.route, response: state.response })
  step.appendChild(el('p', 'decision-dialog__title', copy.line))
  if (copy.note !== null) step.appendChild(el('p', 'decision-dialog__hint', copy.note))

  const actions = el('div', 'decision-dialog__actions')
  if (copy.offerLabelOnly) actions.appendChild(button('Swap labels only', 'decision-retry-label'))
  actions.appendChild(button('Dismiss', 'decision-cancel'))
  step.appendChild(actions)
  return step
}

export function renderDecisionDialog(dialog: HTMLDialogElement, state: DecisionState): void {
  if (state.step === 'closed') {
    if (dialog.open) dialog.close()
    return
  }
  if (!dialog.open) dialog.showModal()

  const body = dialog.querySelector<HTMLElement>('.decision-dialog__body')
  if (!body) return
  body.textContent = ''

  switch (state.step) {
    case 'confirm-unblock':
      body.appendChild(buildConfirmUnblockStep(state))
      break
    case 'confirm-revise':
      body.appendChild(buildConfirmReviseStep(state))
      break
    case 'applying':
      body.appendChild(buildApplyingStep(state.decision))
      break
    case 'result':
      body.appendChild(buildResultStep(state))
      break
  }
}

export function buildDecisionDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'decision-dialog'
  const body = el('div', 'decision-dialog__body')
  dialog.appendChild(body)
  return dialog
}

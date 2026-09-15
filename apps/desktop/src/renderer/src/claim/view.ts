// The claim dialog's DOM (#93) — a native <dialog>, built once and appended
// outside the board's signature-guarded rebuild (`board/view.ts`'s own
// `render`), so a poll landing mid-decision cannot blow away a half-filled
// form. Plain DOM (`createElement`/`textContent` only), the same idiom
// `board/view.ts` already establishes — no framework, no `innerHTML`.
import type { ClaimVerdict } from '../../../shared/claim/types'
import type { ClaimState } from './controller'
import { assigneeCopy, blockersCopy, closedCopy, movedCopy, preflightFailedCopy, primaryButtonLabel, refusalCopy, writeOutcomeCopy } from './copy'

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(label: string, action: string, className = 'claim-dialog__button'): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.textContent = label
  node.dataset.action = action
  return node
}

function noteLine(line: string, note: string): HTMLElement {
  const wrap = el('div', 'claim-dialog__aside')
  wrap.appendChild(el('div', 'claim-dialog__aside-line', line))
  if (note !== '') wrap.appendChild(el('div', 'claim-dialog__aside-note', note))
  return wrap
}

function buildPickStep(state: Extract<ClaimState, { readonly step: 'picking' }>): HTMLElement {
  const step = el('div', 'claim-dialog__step')
  step.appendChild(el('h2', 'claim-dialog__title', 'Work on…'))

  if (state.repos.length === 0) {
    step.appendChild(el('p', 'claim-dialog__hint', 'No port-managed repositories yet. Add one on the Repositories tab.'))
    step.appendChild(button('Cancel', 'claim-cancel'))
    return step
  }

  const repoLabel = el('label', 'claim-dialog__field')
  repoLabel.appendChild(el('span', 'claim-dialog__label', 'Repository'))
  const select = document.createElement('select')
  select.className = 'claim-dialog__select'
  select.dataset.field = 'repo'
  for (const repo of state.repos) {
    const option = document.createElement('option')
    option.value = repo.id
    option.textContent = repo.repo
    if (repo.id === state.repoId) option.selected = true
    select.appendChild(option)
  }
  repoLabel.appendChild(select)
  step.appendChild(repoLabel)

  const numberLabel = el('label', 'claim-dialog__field')
  numberLabel.appendChild(el('span', 'claim-dialog__label', 'Issue number'))
  const input = document.createElement('input')
  input.className = 'claim-dialog__input'
  input.type = 'text'
  input.inputMode = 'numeric'
  input.dataset.field = 'number'
  input.value = state.number
  numberLabel.appendChild(input)
  step.appendChild(numberLabel)

  step.appendChild(
    el(
      'p',
      'claim-dialog__hint',
      'Opt-in labels the issue and assigns it to you. It does not dispatch — a cockpit assigned to you picks it up on its next tick.',
    ),
  )

  if (state.error !== null) step.appendChild(el('p', 'claim-dialog__error', state.error))

  const actions = el('div', 'claim-dialog__actions')
  const submit = button('Continue', 'claim-submit', 'claim-dialog__button claim-dialog__button--primary')
  submit.disabled = state.number.trim() === ''
  actions.appendChild(submit)
  actions.appendChild(button('Cancel', 'claim-cancel'))
  step.appendChild(actions)

  return step
}

function buildLoadingStep(repo: string, number: number): HTMLElement {
  const step = el('div', 'claim-dialog__step')
  step.appendChild(el('p', 'claim-dialog__hint', `Reading #${String(number)} from ${repo}…`))
  return step
}

function buildReviewStep(state: Extract<ClaimState, { readonly step: 'reviewing' }>): HTMLElement {
  const { preflight, verdict } = state
  const step = el('div', 'claim-dialog__step')
  const headline = document.createElement('h2')
  headline.className = 'claim-dialog__title'
  headline.textContent = `#${String(preflight.number)} · ${preflight.title}`
  step.appendChild(headline)

  const claimable = verdict as Extract<ClaimVerdict, { kind: 'claimable' }>

  const blockers = blockersCopy(claimable)
  if (blockers !== null) step.appendChild(noteLine(blockers.line, blockers.note))

  const assignee = assigneeCopy(claimable)
  if (assignee !== null) step.appendChild(noteLine(assignee.line, assignee.note))

  if (claimable.closed) {
    const closed = closedCopy(preflight.number)
    step.appendChild(noteLine(closed.line, closed.note))
  }

  const fieldset = el('div', 'claim-dialog__plan-gate')
  fieldset.appendChild(el('span', 'claim-dialog__label', 'Plan gate'))
  const options: { readonly value: 'review' | 'auto'; readonly label: string; readonly hint: string }[] = [
    { value: 'review', label: 'Review the plan', hint: 'You approve or bounce the plan before any code is written. The default for features.' },
    { value: 'auto', label: 'Auto-approve the plan', hint: 'Skips the plan gate. For small or bug-fix tickets.' },
  ]
  for (const option of options) {
    const row = el('label', 'claim-dialog__radio-row')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'claim-plan-gate'
    radio.value = option.value
    radio.checked = state.planGate === option.value
    radio.dataset.field = 'planGate'
    row.appendChild(radio)
    row.appendChild(el('span', 'claim-dialog__radio-label', option.label))
    row.appendChild(el('span', 'claim-dialog__radio-hint', option.hint))
    fieldset.appendChild(row)
  }
  step.appendChild(fieldset)

  const actions = el('div', 'claim-dialog__actions')
  actions.appendChild(button(primaryButtonLabel(claimable), 'claim-confirm', 'claim-dialog__button claim-dialog__button--primary'))
  actions.appendChild(button('Back', 'claim-back'))
  actions.appendChild(button('Cancel', 'claim-cancel'))
  step.appendChild(actions)

  return step
}

function buildRefusalStep(line: string, note: string | null, url: string | null): HTMLElement {
  const step = el('div', 'claim-dialog__step')
  step.appendChild(el('p', 'claim-dialog__title', line))
  if (note !== null && note !== '') step.appendChild(el('p', 'claim-dialog__hint', note))
  const actions = el('div', 'claim-dialog__actions')
  if (url !== null) {
    const link = document.createElement('a')
    link.className = 'claim-dialog__button'
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = 'Open on GitHub'
    actions.appendChild(link)
  }
  actions.appendChild(button('Close', 'claim-cancel'))
  step.appendChild(actions)
  return step
}

function buildApplyingStep(number: number): HTMLElement {
  const step = el('div', 'claim-dialog__step')
  step.appendChild(el('p', 'claim-dialog__hint', `Claiming #${String(number)}…`))
  return step
}

function buildResultStep(line: string, note: string | null, showRetry: boolean): HTMLElement {
  const step = el('div', 'claim-dialog__step')
  step.appendChild(el('p', 'claim-dialog__title', line))
  if (note !== null && note !== '') step.appendChild(el('p', 'claim-dialog__hint', note))
  const actions = el('div', 'claim-dialog__actions')
  if (showRetry) actions.appendChild(button('Show me the current state', 'claim-retry-preflight'))
  actions.appendChild(button('Dismiss', 'claim-cancel'))
  step.appendChild(actions)
  return step
}

/** Renders the dialog's body for the current state and opens/closes the
 *  native `<dialog>` element to match — `closed` is the only state that
 *  closes it, everything else keeps it open (or opens it, on the first
 *  transition away from `closed`). */
export function renderClaimDialog(dialog: HTMLDialogElement, state: ClaimState): void {
  if (state.step === 'closed') {
    if (dialog.open) dialog.close()
    return
  }
  if (!dialog.open) dialog.showModal()

  const body = dialog.querySelector<HTMLElement>('.claim-dialog__body')
  if (!body) return
  body.textContent = ''

  switch (state.step) {
    case 'picking':
      body.appendChild(buildPickStep(state))
      break
    case 'loading':
      body.appendChild(buildLoadingStep(state.repo, state.number))
      break
    case 'reviewing':
      body.appendChild(buildReviewStep(state))
      break
    case 'refused': {
      const copy = refusalCopy(state.repo, state.number, state.verdict)
      body.appendChild(buildRefusalStep(copy.line, copy.note, state.url))
      break
    }
    case 'preflight-failed': {
      const copy = preflightFailedCopy(state.message)
      body.appendChild(buildRefusalStep(copy.line, copy.note, null))
      break
    }
    case 'applying':
      body.appendChild(buildApplyingStep(state.number))
      break
    case 'moved': {
      const copy = movedCopy(state.current, state.readAt)
      body.appendChild(buildResultStep(copy.line, copy.note, true))
      break
    }
    case 'refused-at-apply': {
      const copy = refusalCopy(state.repo, state.number, state.verdict)
      body.appendChild(buildResultStep(copy.line, copy.note, false))
      break
    }
    case 'write-result': {
      const copy = writeOutcomeCopy(state.number, state.outcome)
      body.appendChild(buildResultStep(copy.line, copy.note, state.outcome.kind === 'precondition-failed'))
      break
    }
  }
}

export function buildClaimDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'claim-dialog'
  const body = el('div', 'claim-dialog__body')
  dialog.appendChild(body)
  return dialog
}

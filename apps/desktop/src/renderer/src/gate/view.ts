// The plan gate dialog's DOM (#92) — a native <dialog>, built once and
// appended outside the board's signature-guarded rebuild (`board/view.ts`'s
// own `render`), so a poll landing mid-decision cannot blow away a
// half-written change request. Plain DOM (`createElement`/`textContent`
// only), the same idiom `claim/view.ts` already establishes.
import type { ClaimRead } from '../../../shared/writes/types'
import { renderMarkdown } from '../markdown'
import type { GateState } from './controller'
import {
  assigneeNoteCopy,
  autoPlanNoteCopy,
  claimLineCopy,
  feedbackHint,
  isClaimHeldForPlanGate,
  noPlanNoteCopy,
  primaryApproveLabel,
  refusedVerdictCopy,
  resultCopy,
  sessionRequiredCopy,
} from './copy'

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(label: string, action: string, className = 'gate-dialog__button'): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.textContent = label
  node.dataset.action = action
  return node
}

function noteLine(line: string, note: string | null): HTMLElement {
  const wrap = el('div', 'gate-dialog__aside')
  wrap.appendChild(el('div', 'gate-dialog__aside-line', line))
  if (note !== null && note !== '') wrap.appendChild(el('div', 'gate-dialog__aside-note', note))
  return wrap
}

function buildClaimPickingStep(state: Extract<GateState, { readonly step: 'claim-picking' }>): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  step.appendChild(el('h2', 'gate-dialog__title', 'Plan gate'))

  if (state.repos.length === 0) {
    step.appendChild(el('p', 'gate-dialog__hint', 'No port-managed repositories yet.'))
    step.appendChild(button('Cancel', 'gate-cancel'))
    return step
  }

  if (state.repos.length > 1) {
    const label = el('label', 'gate-dialog__field')
    label.appendChild(el('span', 'gate-dialog__label', 'Repository'))
    const select = document.createElement('select')
    select.className = 'gate-dialog__select'
    select.dataset.field = 'repo'
    for (const repo of state.repos) {
      const option = document.createElement('option')
      option.value = repo.id
      option.textContent = repo.repo
      if (repo.id === state.repoId) option.selected = true
      select.appendChild(option)
    }
    label.appendChild(select)
    step.appendChild(label)
  }

  step.appendChild(button('Cancel', 'gate-cancel'))
  return step
}

function buildClaimStatusStep(claim: ClaimRead, acting: boolean): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  step.appendChild(el('h2', 'gate-dialog__title', 'Plan gate'))
  const copy = claimLineCopy(claim)
  step.appendChild(noteLine(copy.line, copy.note))

  const actions = el('div', 'gate-dialog__actions')
  if (copy.action === 'take') actions.appendChild(button('Take the plan gate', 'gate-claim-take'))
  else if (copy.action === 'release') actions.appendChild(button('Release the plan gate', 'gate-claim-release'))
  else if (copy.action === 'overwrite') {
    actions.appendChild(button('Overwrite with a fresh claim', 'gate-claim-overwrite'))
    actions.appendChild(button('Delete the file', 'gate-claim-delete'))
  }
  for (const b of actions.querySelectorAll('button')) b.disabled = acting
  actions.appendChild(button('Cancel', 'gate-cancel'))
  step.appendChild(actions)
  return step
}

function buildLoadingStep(hint: string): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  step.appendChild(el('p', 'gate-dialog__hint', hint))
  return step
}

function buildReviewingStep(state: Extract<GateState, { readonly step: 'reviewing' }>): HTMLElement {
  const { preflight, verdict, claim } = state
  const step = el('div', 'gate-dialog__step')

  const headline = document.createElement('h2')
  headline.className = 'gate-dialog__title'
  headline.textContent = `#${String(preflight.number)} · ${preflight.title}`
  step.appendChild(headline)

  const link = document.createElement('a')
  link.className = 'gate-dialog__link'
  link.href = preflight.url
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = 'Open on GitHub'
  step.appendChild(link)

  if (preflight.sessionRequired && preflight.sessionRequiredReason !== null) {
    const banner = sessionRequiredCopy(preflight.number, preflight.title, preflight.sessionRequiredReason)
    const wrap = el('div', 'gate-dialog__banner')
    wrap.appendChild(el('div', 'gate-dialog__banner-title', banner.banner))
    wrap.appendChild(el('div', 'gate-dialog__banner-note', banner.note))
    const launch = el('code', 'gate-dialog__launch', banner.launchLine)
    wrap.appendChild(launch)
    step.appendChild(wrap)
  }

  if (preflight.autoPlan) step.appendChild(el('p', 'gate-dialog__note', autoPlanNoteCopy()))

  if (verdict.assignedElsewhere.length > 0) {
    for (const login of verdict.assignedElsewhere) step.appendChild(el('p', 'gate-dialog__note', assigneeNoteCopy(login)))
  }

  if (verdict.noPlanBlock) step.appendChild(el('p', 'gate-dialog__note', noPlanNoteCopy()))

  const body = el('div', 'gate-dialog__body-markdown')
  renderMarkdown(body, preflight.planMarkdown ?? preflight.ticketMarkdown)
  step.appendChild(body)

  const held = isClaimHeldForPlanGate(claim)
  const claimCopy = claimLineCopy(claim)
  const claimLine = noteLine(claimCopy.line, claimCopy.note)
  if (!held && claimCopy.action === 'take') claimLine.appendChild(button('Take the plan gate', 'gate-claim-take'))
  step.appendChild(claimLine)

  const actions = el('div', 'gate-dialog__actions')
  const approve = button(primaryApproveLabel(preflight.sessionRequired), 'gate-approve', 'gate-dialog__button gate-dialog__button--primary')
  approve.disabled = !held
  actions.appendChild(approve)
  const requestChanges = button('Request changes', 'gate-request-changes')
  requestChanges.disabled = !held
  actions.appendChild(requestChanges)
  actions.appendChild(button('Cancel', 'gate-cancel'))
  step.appendChild(actions)

  return step
}

function buildFeedbackStep(state: Extract<GateState, { readonly step: 'feedback' }>): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  step.appendChild(el('h2', 'gate-dialog__title', 'What should change?'))
  const textarea = document.createElement('textarea')
  textarea.className = 'gate-dialog__textarea'
  textarea.dataset.field = 'feedback'
  textarea.value = state.text
  step.appendChild(textarea)
  step.appendChild(el('p', 'gate-dialog__hint', feedbackHint(state.preflight.number)))

  const actions = el('div', 'gate-dialog__actions')
  const submit = button('Post and request changes', 'gate-feedback-submit', 'gate-dialog__button gate-dialog__button--primary')
  submit.disabled = state.text.trim() === ''
  actions.appendChild(submit)
  actions.appendChild(button('Back', 'gate-feedback-back'))
  actions.appendChild(button('Cancel', 'gate-cancel'))
  step.appendChild(actions)
  return step
}

function buildRefusedStep(number: number, verdict: Extract<GateState, { readonly step: 'refused' }>['verdict']): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  const copy = refusedVerdictCopy(number, verdict)
  step.appendChild(el('p', 'gate-dialog__title', copy.line))
  if (copy.note !== null) step.appendChild(el('p', 'gate-dialog__hint', copy.note))
  const actions = el('div', 'gate-dialog__actions')
  actions.appendChild(button('Show me the current state', 'gate-retry-preflight'))
  actions.appendChild(button('Dismiss', 'gate-cancel'))
  step.appendChild(actions)
  return step
}

function buildErrorStep(line: string, note: string): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  step.appendChild(el('p', 'gate-dialog__title', line))
  step.appendChild(el('p', 'gate-dialog__hint', note))
  step.appendChild(button('Dismiss', 'gate-cancel'))
  return step
}

function buildResultStep(state: Extract<GateState, { readonly step: 'result' }>): HTMLElement {
  const step = el('div', 'gate-dialog__step')
  const sessionRequired = state.preflight.sessionRequired
  const copy = resultCopy({ number: state.preflight.number, decision: state.decision, response: state.response, sessionRequired })
  step.appendChild(el('p', 'gate-dialog__title', copy.line))
  if (copy.note !== null && copy.note !== '') step.appendChild(el('p', 'gate-dialog__hint', copy.note))

  const actions = el('div', 'gate-dialog__actions')
  for (const action of copy.actions) {
    if (action === 'retry-label') actions.appendChild(button('Retry the label change', 'gate-retry-label'))
    else if (action === 'show-state') actions.appendChild(button('Show me the current state', 'gate-retry-preflight'))
    else if (action === 'try-again') actions.appendChild(button('Try again', 'gate-try-again'))
    else if (action === 'take-claim') actions.appendChild(button('Take the plan gate', 'gate-take-claim'))
  }
  actions.appendChild(button('Dismiss', 'gate-cancel'))
  step.appendChild(actions)
  return step
}

/** Renders the dialog's body for the current state and opens/closes the
 *  native `<dialog>` element to match — `closed` is the only state that
 *  closes it, everything else keeps it open. */
export function renderGateDialog(dialog: HTMLDialogElement, state: GateState): void {
  if (state.step === 'closed') {
    if (dialog.open) dialog.close()
    return
  }
  if (!dialog.open) dialog.showModal()

  const body = dialog.querySelector<HTMLElement>('.gate-dialog__body')
  if (!body) return
  body.textContent = ''

  switch (state.step) {
    case 'claim-picking':
      body.appendChild(buildClaimPickingStep(state))
      break
    case 'claim-loading':
      body.appendChild(buildLoadingStep('Reading the plan gate…'))
      break
    case 'claim-view':
      body.appendChild(buildClaimStatusStep(state.claim, false))
      break
    case 'claim-acting':
      body.appendChild(buildLoadingStep('Updating the plan gate…'))
      break
    case 'claim-failed':
      body.appendChild(buildErrorStep("Couldn't reach the main process.", state.message))
      break
    case 'loading':
      body.appendChild(buildLoadingStep(`Reading #${String(state.number)}…`))
      break
    case 'reviewing':
      body.appendChild(buildReviewingStep(state))
      break
    case 'feedback':
      body.appendChild(buildFeedbackStep(state))
      break
    case 'answering':
      body.appendChild(buildLoadingStep(`Answering #${String(state.number)}…`))
      break
    case 'refused':
      body.appendChild(buildRefusedStep(state.number, state.verdict))
      break
    case 'preflight-failed':
      body.appendChild(buildErrorStep("Couldn't reach GitHub.", state.message))
      break
    case 'result':
      body.appendChild(buildResultStep(state))
      break
  }
}

export function buildGateDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'gate-dialog'
  const body = el('div', 'gate-dialog__body')
  dialog.appendChild(body)
  return dialog
}

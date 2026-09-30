// #99: the permission dialog's DOM — a native <dialog>, built once and
// appended to #app outside the board's signature-guarded rebuild, the same
// idiom `claim/view.ts` and `gate/view.ts` already establish. Plain DOM
// (`createElement`/`textContent` only) — no framework, no `innerHTML`.
//
// Unlike `claim`/`gate`, this dialog's own state changes on a timer (the
// 600ms arming delay) and mid-turn IPC pushes, not only on operator
// keystrokes — so a full-body rebuild on every redraw would blow away the
// deny-reason textarea's own cursor and focus while the operator is mid
// sentence. `renderPermissionDialog` therefore rebuilds from scratch only
// when the *identity* of the showing permission changes (a new prompt, or
// the dialog opening); a redraw for the same permission patches only what
// changed (button labels, disabled state, the inline error) and never
// touches the textarea node at all.
import type { PendingPermission, PermissionDecision } from '../../../shared/hosting/types'
import {
  ALLOW_ONCE_LABEL,
  ALLOW_SESSION_LABEL,
  blockedPathLine,
  contextLine,
  decisionReasonLine,
  DENY_LABEL,
  DENY_MESSAGE_LABEL,
  DENY_MESSAGE_MAXLENGTH,
  DENY_MESSAGE_PLACEHOLDER,
  formatInput,
  grantSummaryLine,
  headingText,
  INPUT_UNRENDERABLE_MESSAGE,
  primaryLine,
  SENDING_LABEL,
} from './copy'

export interface PermissionDialogProps {
  readonly permission: PendingPermission
  readonly repoLabel: string
  readonly sessionKey: string
  readonly index: number
  readonly total: number
  readonly message: string
  readonly armed: boolean
  readonly sending: PermissionDecision | null
  readonly error: string | null
}

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(label: string, action: string, role: string, className = 'permission-dialog__button'): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.textContent = label
  node.dataset.action = action
  node.dataset.role = role
  return node
}

export function buildPermissionDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'permission-dialog'
  const body = el('div', 'permission-dialog__body')
  dialog.appendChild(body)
  return dialog
}

function buildBody(props: PermissionDialogProps): HTMLElement {
  const { permission } = props
  const step = el('div', 'permission-dialog__step')

  step.appendChild(el('h2', 'permission-dialog__title', headingText(permission)))
  step.appendChild(el('p', 'permission-dialog__context', contextLine(props.repoLabel, props.sessionKey, permission.agentId, props.index, props.total)))

  if (permission.description !== null && permission.description !== '') {
    step.appendChild(el('p', 'permission-dialog__hint', permission.description))
  }
  if (permission.decisionReason !== null && permission.decisionReason !== '') {
    step.appendChild(el('p', 'permission-dialog__hint', decisionReasonLine(permission.decisionReason)))
  }
  if (permission.blockedPath !== null && permission.blockedPath !== '') {
    step.appendChild(el('p', 'permission-dialog__hint', blockedPathLine(permission.blockedPath)))
  }

  const primary = primaryLine(permission.toolName, permission.input)
  if (primary !== null) {
    const block = document.createElement('pre')
    block.className = 'permission-dialog__primary'
    block.textContent = primary
    step.appendChild(block)
  }

  const formatted = formatInput(permission.input)

  if (formatted.ok) {
    step.appendChild(el('span', 'permission-dialog__label', 'Full input'))
    const pre = document.createElement('pre')
    pre.className = 'permission-dialog__input'
    pre.textContent = formatted.text
    step.appendChild(pre)
  } else {
    step.appendChild(el('p', 'permission-dialog__error', INPUT_UNRENDERABLE_MESSAGE))
  }

  if (formatted.ok) {
    const label = el('label', 'permission-dialog__field')
    label.appendChild(el('span', 'permission-dialog__label', DENY_MESSAGE_LABEL))
    const textarea = document.createElement('textarea')
    textarea.className = 'permission-dialog__textarea'
    textarea.dataset.field = 'permission-message'
    textarea.dataset.role = 'message-textarea'
    textarea.placeholder = DENY_MESSAGE_PLACEHOLDER
    textarea.maxLength = DENY_MESSAGE_MAXLENGTH
    textarea.value = props.message
    label.appendChild(textarea)
    step.appendChild(label)
  }

  const errorLine = el('p', 'permission-dialog__error')
  errorLine.dataset.role = 'error'
  errorLine.hidden = props.error === null
  errorLine.textContent = props.error ?? ''
  step.appendChild(errorLine)

  const actions = el('div', 'permission-dialog__actions')

  const denyButton = button(DENY_LABEL, 'permission-deny', 'deny-button', 'permission-dialog__button permission-dialog__button--deny')
  actions.appendChild(denyButton)

  if (formatted.ok) {
    const allowOnce = button(ALLOW_ONCE_LABEL, 'permission-allow-once', 'allow-once-button', 'permission-dialog__button permission-dialog__button--primary')
    actions.appendChild(allowOnce)

    if (permission.sessionGrant !== null) {
      const wrap = el('div', 'permission-dialog__session-grant')
      const allowSession = button(ALLOW_SESSION_LABEL, 'permission-allow-session', 'allow-session-button')
      wrap.appendChild(allowSession)
      wrap.appendChild(el('div', 'permission-dialog__grant-note', grantSummaryLine(permission.sessionGrant)))
      actions.appendChild(wrap)
    }
  }

  step.appendChild(actions)
  applyButtonState(step, props)
  return step
}

/** Sets every button's label and `disabled` state from `props` alone —
 *  called once by `buildBody` on a fresh build, and again by `patchBody` on
 *  every redraw for the same permission. Never touches the textarea. */
function applyButtonState(root: ParentNode, props: PermissionDialogProps): void {
  const busy = props.sending !== null
  const deny = root.querySelector<HTMLButtonElement>('[data-role="deny-button"]')
  if (deny) {
    deny.textContent = props.sending === 'deny' ? SENDING_LABEL : DENY_LABEL
    deny.disabled = busy
  }
  const allowOnce = root.querySelector<HTMLButtonElement>('[data-role="allow-once-button"]')
  if (allowOnce) {
    allowOnce.textContent = props.sending === 'allow-once' ? SENDING_LABEL : ALLOW_ONCE_LABEL
    allowOnce.disabled = busy || !props.armed
  }
  const allowSession = root.querySelector<HTMLButtonElement>('[data-role="allow-session-button"]')
  if (allowSession) {
    allowSession.textContent = props.sending === 'allow-session' ? SENDING_LABEL : ALLOW_SESSION_LABEL
    allowSession.disabled = busy || !props.armed
  }
  const error = root.querySelector<HTMLElement>('[data-role="error"]')
  if (error) {
    error.hidden = props.error === null
    error.textContent = props.error ?? ''
  }
}

/** Renders the dialog's body for the current queued permission, opening or
 *  closing the native `<dialog>` to match — `null` closes it. A change in
 *  *which* permission is showing rebuilds the body from scratch and moves
 *  focus to **Deny**, so a stray Enter from whatever the operator was
 *  typing denies rather than allows; a redraw for the same permission
 *  patches button state in place, leaving a mid-edit textarea untouched. */
export function renderPermissionDialog(dialog: HTMLDialogElement, props: PermissionDialogProps | null, previousPermissionId: string | null): void {
  if (props === null) {
    if (dialog.open) dialog.close()
    return
  }

  const body = dialog.querySelector<HTMLElement>('.permission-dialog__body')
  if (!body) return

  if (props.permission.permissionId !== previousPermissionId) {
    body.textContent = ''
    body.appendChild(buildBody(props))
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLButtonElement>('[data-action="permission-deny"]')?.focus()
    return
  }

  if (!dialog.open) dialog.showModal()
  applyButtonState(body, props)
}

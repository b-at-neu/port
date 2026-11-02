export interface ToastButton {
  readonly label: string
  readonly onClick: () => void
}

export interface ActionToast {
  readonly tone: 'success' | 'error' | 'info'
  readonly title: string
  readonly description: string | null
  readonly action: ToastButton | null
  readonly cancel: ToastButton | null
}

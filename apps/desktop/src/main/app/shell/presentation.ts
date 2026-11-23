type ModeKind = 'off' | 'ignored' | 'invalid' | 'on'

type WindowPresentation = {
  show: 'focus' | 'inactive'
  backgroundThrottling: boolean
  activationPolicy: 'accessory' | null
}

type Showable = { show(): void; showInactive(): void }

export function windowPresentation(input: { fixture: ModeKind; e2e: ModeKind; platform: NodeJS.Platform }): WindowPresentation {
  if (input.fixture === 'on' || input.e2e === 'on') {
    return { show: 'inactive', backgroundThrottling: false, activationPolicy: input.fixture === 'on' && input.platform === 'darwin' ? 'accessory' : null }
  }
  return { show: 'focus', backgroundThrottling: true, activationPolicy: null }
}

export function presentWindow(window: Showable, presentation: WindowPresentation): void {
  if (presentation.show === 'inactive') window.showInactive()
  else window.show()
}

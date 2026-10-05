// Pure `GhStatus → pill, body, footer-dot contribution` for the Settings screen.
import type { GhStatus } from '../../../shared/gh/types'
import type { PillStatus } from '../components/status-pill'

export interface GhStatusModel {
  readonly pillStatus: PillStatus
  readonly pillLabel: string
  readonly body: string
}

export function ghStatusModel(status: GhStatus): GhStatusModel {
  switch (status.kind) {
    case 'signed-in':
      return { pillStatus: 'success', pillLabel: 'Signed in', body: 'port reads and writes GitHub through your gh login.' }
    case 'signed-out':
      return { pillStatus: 'danger', pillLabel: 'Signed out', body: 'gh is signed out. Run `gh auth login`, then check again.' }
    case 'missing':
      return { pillStatus: 'danger', pillLabel: 'Not installed', body: "gh isn't on your PATH. Install the GitHub CLI, then check again." }
    case 'unknown':
      return { pillStatus: 'idle', pillLabel: "Couldn't check", body: `Running \`gh auth status\` failed: ${status.message}` }
  }
}

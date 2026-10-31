// Pure `GhStatus → pill, body` for the Settings screen.
import type { GhStatus } from '@/types/gh'
import type { PillStatus } from '@/types/components'

interface GhStatusModel {
  readonly pillStatus: PillStatus
  readonly pillLabel: string
  readonly body: string
  /** `Scopes: repo, read:org` — only when the scopes could be read. */
  readonly scopesLine: string | null
}

export function ghStatusModel(status: GhStatus): GhStatusModel {
  switch (status.kind) {
    case 'signed-in':
      return {
        pillStatus: 'success',
        pillLabel: 'Signed in',
        body: status.account !== null ? `Signed in as ${status.account}.` : 'port reads and writes GitHub through your gh login.',
        scopesLine: status.scopes !== null ? `Scopes: ${status.scopes.length > 0 ? status.scopes.join(', ') : 'none'}` : null,
      }
    case 'signed-out':
      return { pillStatus: 'danger', pillLabel: 'Signed out', body: 'gh is signed out. Run `gh auth login`, then check again.', scopesLine: null }
    case 'missing':
      return { pillStatus: 'danger', pillLabel: 'Not installed', body: "gh isn't on your PATH. Install the GitHub CLI, then check again.", scopesLine: null }
    case 'unknown':
      return { pillStatus: 'idle', pillLabel: "Couldn't check", body: `Running \`gh auth status\` failed: ${status.message}`, scopesLine: null }
  }
}

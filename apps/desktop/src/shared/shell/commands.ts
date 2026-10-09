// The app menu's own command table — one entry per global §3 chord, built from and pinned
// against key-bindings.ts by the desktop-shell check. Shared by main/menu.ts (which builds
// the Electron template) and the renderer (which runs the same action a key press would).
import type { SessionKey } from '../hosting/types'

export interface AppCommandSpec {
  readonly kind: 'palette' | 'new-session' | 'toggle-sidebar' | 'rename-session' | 'next-session' | `jump-to-session-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  readonly label: string
  readonly accelerator: string
  readonly group: 'File' | 'View' | 'Session'
}

export const APP_COMMANDS: readonly AppCommandSpec[] = [
  { kind: 'new-session', label: 'New session', accelerator: 'CmdOrCtrl+N', group: 'File' },
  { kind: 'palette', label: 'Command palette', accelerator: 'CmdOrCtrl+K', group: 'View' },
  { kind: 'toggle-sidebar', label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', group: 'View' },
  { kind: 'rename-session', label: 'Rename session', accelerator: 'F2', group: 'Session' },
  { kind: 'next-session', label: 'Next session', accelerator: 'Ctrl+Tab', group: 'Session' },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(
    (n): AppCommandSpec => ({ kind: `jump-to-session-${n}`, label: `Session ${String(n)}`, accelerator: `CmdOrCtrl+${String(n)}`, group: 'Session' }),
  ),
]

/** Every command a menu click or a notification click can push — the renderer validates
 *  `kind` against `APP_COMMANDS` (plus `open-session`) and ignores anything unknown. */
export type AppCommand = { readonly kind: AppCommandSpec['kind'] } | { readonly kind: 'open-session'; readonly sessionKey: SessionKey }

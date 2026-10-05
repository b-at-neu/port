// DESIGN §3's keyboard table, as data (#316). `keys` is copied verbatim from
// the table so the `desktop-shell` pin can check this file against that
// table in both directions. No runtime imports — the pin imports this
// module directly.
export interface KeyBinding {
  readonly keys: string
  readonly action: string
  readonly scope: 'global' | 'composer' | 'list'
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { keys: 'Ctrl/Cmd+K', action: 'Command palette', scope: 'global' },
  { keys: 'Ctrl/Cmd+N', action: 'New session', scope: 'global' },
  { keys: 'Ctrl/Cmd+1…9', action: 'Jump to session', scope: 'global' },
  { keys: 'Ctrl/Cmd+Tab', action: 'Next session', scope: 'global' },
  { keys: 'Ctrl/Cmd+B', action: 'Toggle sidebar', scope: 'global' },
  { keys: 'F2', action: 'Rename session', scope: 'global' },
  { keys: 'Enter / Shift+Enter', action: 'Send / new line in the composer', scope: 'composer' },
  { keys: 'Esc', action: "Stop Claude's turn when the composer is focused; otherwise close the pane or dialog", scope: 'composer' },
  { keys: 'J / K, then Enter', action: 'Move through Board and Backlog rows, open the selected one', scope: 'list' },
]

// `keys` is copied verbatim so a pin can check this against the design doc.
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
  { keys: 'Shift+Tab', action: 'Cycle the permission mode in the composer', scope: 'composer' },
  { keys: '↑ / ↓', action: 'Previous / next sent prompt when the composer is empty', scope: 'composer' },
  { keys: 'Esc', action: "Close suggestions, else stop Claude's turn when the composer is focused; otherwise close the pane or dialog", scope: 'composer' },
  { keys: 'J / K, then Enter', action: 'Move through Board and Backlog rows, open the selected one', scope: 'list' },
]

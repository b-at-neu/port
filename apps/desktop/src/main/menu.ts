// Builds the Electron application menu from the shared APP_COMMANDS table. Pure template
// construction — main/index.ts calls Menu.buildFromTemplate(menuTemplate(...)) in whenReady.
import type { MenuItemConstructorOptions } from 'electron'
import { APP_COMMANDS } from '@/utils/shell/commands'
import type { AppCommand, AppCommandSpec } from '@/utils/shell/commands'
import type { SessionKey } from '@/types/hosting'
import { MAX_JUMP_SESSIONS } from '@/utils/shell/session-order'

export interface MenuSessionEntry {
  readonly label: string
  readonly sessionKey: SessionKey
}

function commandItem(spec: AppCommandSpec, send: (command: AppCommand) => void): MenuItemConstructorOptions {
  // registerAccelerator: false shows the chord but never lets the native menu swallow the
  // keydown — keyboard.ts's single listener stays the one place a key press actually fires.
  return { label: spec.label, accelerator: spec.accelerator, registerAccelerator: false, click: () => send({ kind: spec.kind }) }
}

function groupItems(group: AppCommandSpec['group'], send: (command: AppCommand) => void): MenuItemConstructorOptions[] {
  return APP_COMMANDS.filter((spec) => spec.group === group).map((spec) => commandItem(spec, send))
}

// A click sends `open-session` with the exact key shown, rather than `jump-to-session-n`, so it
// still lands on the right row even if the order changed while the menu was open.
function jumpItem(entry: MenuSessionEntry, index: number, send: (command: AppCommand) => void): MenuItemConstructorOptions {
  const spec = APP_COMMANDS.find((candidate) => candidate.kind === `jump-to-session-${index + 1}`)
  if (spec === undefined) throw new Error(`menuTemplate: missing jump-to-session-${String(index + 1)} command`)
  return { label: entry.label, accelerator: spec.accelerator, registerAccelerator: false, click: () => send({ kind: 'open-session', sessionKey: entry.sessionKey }) }
}

/** Pure — `platform`/`isPackaged`/`sessions` are passed in rather than read from `process`/`app`/the
 *  store. `sessions` is already ordered (pinned first) by the caller. */
export function menuTemplate(platform: NodeJS.Platform, isPackaged: boolean, sessions: readonly MenuSessionEntry[], send: (command: AppCommand) => void): MenuItemConstructorOptions[] {
  const jumpSubmenu: MenuItemConstructorOptions[] =
    sessions.length === 0 ? [{ label: 'No sessions open', enabled: false }] : sessions.slice(0, MAX_JUMP_SESSIONS).map((entry, index) => jumpItem(entry, index, send))

  const fileItems = groupItems('File', send)
  // 'Session'-group commands are rename-session and next-session; the nine jump commands feed
  // the submenu above instead of nine flat items.
  const sessionItems = APP_COMMANDS.filter((spec) => spec.group === 'Session' && !spec.kind.startsWith('jump-to-session')).map((spec) => commandItem(spec, send))
  const sessionMenu: MenuItemConstructorOptions[] = [...sessionItems, { type: 'separator' }, { label: 'Go to session', submenu: jumpSubmenu }]

  const viewItems: MenuItemConstructorOptions[] = [...groupItems('View', send)]
  if (!isPackaged) {
    viewItems.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
  }

  const template: MenuItemConstructorOptions[] = []
  if (platform === 'darwin') {
    template.push({
      label: 'port',
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    })
  }

  template.push(
    { label: 'File', submenu: platform === 'darwin' ? [...fileItems, { type: 'separator' }, { role: 'close' }] : [...fileItems, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', role: 'editMenu' },
    { label: 'View', submenu: viewItems },
    { label: 'Session', submenu: sessionMenu },
    { label: 'Window', role: 'windowMenu' },
  )

  return template
}

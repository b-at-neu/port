// Builds the Electron application menu from the shared APP_COMMANDS table. Pure template
// construction — main/index.ts calls Menu.buildFromTemplate(menuTemplate(...)) in whenReady.
import type { MenuItemConstructorOptions } from 'electron'
import { APP_COMMANDS } from '../shared/shell/commands'
import type { AppCommand, AppCommandSpec } from '../shared/shell/commands'

function commandItem(spec: AppCommandSpec, send: (command: AppCommand) => void): MenuItemConstructorOptions {
  // registerAccelerator: false shows the chord but never lets the native menu swallow the
  // keydown — keyboard.ts's single listener stays the one place a key press actually fires.
  return { label: spec.label, accelerator: spec.accelerator, registerAccelerator: false, click: () => send({ kind: spec.kind }) }
}

function groupItems(group: AppCommandSpec['group'], send: (command: AppCommand) => void): MenuItemConstructorOptions[] {
  return APP_COMMANDS.filter((spec) => spec.group === group).map((spec) => commandItem(spec, send))
}

/** Pure — `platform`/`isPackaged` are passed in rather than read from `process`/`app`, so this is testable without Electron running. */
export function menuTemplate(platform: NodeJS.Platform, isPackaged: boolean, send: (command: AppCommand) => void): MenuItemConstructorOptions[] {
  const jumpSubmenu: MenuItemConstructorOptions[] = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => {
    const spec = APP_COMMANDS.find((candidate) => candidate.kind === `jump-to-session-${n}`)
    if (spec === undefined) throw new Error(`menuTemplate: missing jump-to-session-${String(n)} command`)
    return commandItem(spec, send)
  })

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

// The only file in the registry path that imports Electron — injected into
// the registry module (`src/main/registry/index.ts`) so its own tests need
// no Electron. The picker lives here, in main, rather than the renderer
// sending a path: an arbitrary directory reachable from web content would
// be a strictly worse boundary for no gain. `confirmQuit` (#326) is this
// file's second native dialog, for `main/dispatch/quit.ts`'s own guard.
import { dialog, type BrowserWindow } from 'electron'
import type { QuitWarningCopy } from './dispatch/quit'

/** Opens the native directory picker and returns the chosen path, or `null`
 *  on cancel. */
export async function chooseDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Add a port-managed repository',
    buttonLabel: 'Add',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** The quit-warning message box — `defaultId`/`cancelId` both point at
 *  Cancel, so Enter and Esc both land on the safe choice. Resolves `true`
 *  only when the operator picked the confirm button (index 0). */
export async function confirmQuit(window: BrowserWindow | null, copy: QuitWarningCopy): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: [copy.confirmLabel, copy.cancelLabel],
    defaultId: 1,
    cancelId: 1,
    message: copy.message,
    detail: copy.detail,
  }
  const result = window !== null ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

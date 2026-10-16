// Pure path resolution for the app's window/dock icon — no `electron` import, so it is testable
// without a running app. `scripts/icon.mjs` renders the PNG files this points at.
import { join } from 'node:path'

export interface IconPathInput {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  /** `__dirname` of the running main bundle — `out/main` in both dev and packaged builds. */
  readonly mainDir: string
  readonly resourcesPath: string
}

/** The `BrowserWindow` `icon` option. macOS ignores it (the bundle icon covers packaged, and dev
 *  uses `devDockIconPath` instead); packaged Windows uses the exe's own embedded icon. */
export function windowIconPath(input: IconPathInput): string | null {
  if (input.platform === 'darwin') return null
  if (!input.isPackaged) return join(input.mainDir, '../../build/icon.png')
  if (input.platform === 'win32') return null
  return join(input.resourcesPath, 'icon.png')
}

/** The path to hand `app.dock.setIcon` — only macOS dev needs this; the packaged bundle icon
 *  already covers macOS, and no other platform has a dock. */
export function devDockIconPath(input: IconPathInput): string | null {
  if (input.platform !== 'darwin' || input.isPackaged) return null
  return join(input.mainDir, '../../build/icon.png')
}

// The only file in the registry path that imports Electron — injected into
// the registry module (`src/main/registry/index.ts`) so its own tests need
// no Electron. The picker lives here, in main, rather than the renderer
// sending a path: an arbitrary directory reachable from web content would
// be a strictly worse boundary for no gain.
import { dialog } from 'electron'

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

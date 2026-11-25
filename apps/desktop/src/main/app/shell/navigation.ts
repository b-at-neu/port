import { shell } from 'electron'
import type { WebContents } from 'electron'

export function shouldOpenExternally(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isSameOrigin(url: string, current: string): boolean {
  try {
    return new URL(url).origin === new URL(current).origin
  } catch {
    return false
  }
}

export function applyNavigationGuards(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url, webContents.getURL())) return
    event.preventDefault()
    if (shouldOpenExternally(url)) {
      void shell.openExternal(url)
    }
  })
}

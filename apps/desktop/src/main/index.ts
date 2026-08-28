import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { applyNavigationGuards } from './navigation'

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  function createWindow(): void {
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      title: 'Port',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    mainWindow = window

    applyNavigationGuards(window.webContents)

    window.on('ready-to-show', () => {
      window.show()
    })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      window.loadURL(rendererUrl).catch((error: unknown) => {
        console.error('[window] load failed', error)
      })
    } else {
      window.loadFile(join(__dirname, '../renderer/index.html')).catch((error: unknown) => {
        console.error('[window] load failed', error)
      })
    }
  }

  void app.whenReady().then(() => {
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

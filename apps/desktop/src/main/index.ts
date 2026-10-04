import { app, BrowserWindow } from 'electron'
import { isAbsolute, join } from 'node:path'
import { registerIpc } from './ipc'
import { registerFixtureIpc } from './fixtures'
import { fixtureMode } from './fixtures/mode'
import type { PipelineWatcher } from './state'
import type { HostedStore } from './hosting'
import { applyNavigationGuards } from './navigation'

// A dev-only `pnpm install` never runs as root, so the SUID sandbox helper
// (`chrome-sandbox`) ships without the root-owned 4755 permissions Chromium
// requires, and aborts rather than falling back unprivileged. Packaged
// builds are unaffected — installers set up `chrome-sandbox` correctly.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox')
}

// #317: the visual harness's own fixture-mode switch, resolved before the
// single-instance lock — an `on` result relocates `userData` before that
// lock is ever requested, so a fixture run never contends for the operator's
// own lock or touches their real profile.
const fixture = fixtureMode(process.env, app.isPackaged, isAbsolute)

if (fixture.kind === 'invalid') {
  console.error(`[fixtures] ${fixture.reason}`)
  app.exit(1)
} else {
  if (fixture.kind === 'ignored') {
    console.warn('[fixtures] PORT_FIXTURES is set but ignored in a packaged build')
  }
  if (fixture.kind === 'on') {
    app.setPath('userData', fixture.userData)
  }

  const gotLock = app.requestSingleInstanceLock()

  if (!gotLock) {
    app.quit()
  } else {
    let mainWindow: BrowserWindow | null = null
    let watcher: PipelineWatcher | null = null
    let hostedStore: HostedStore | null = null

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
      // #317: fixture mode registers its own canned handlers instead of the
      // live adapter chain, and starts neither a watcher nor a hosted-session
      // store — both stay `null`, so `before-quit` below no-ops for them.
      if (fixture.kind === 'on') {
        registerFixtureIpc()
      } else {
        const registered = registerIpc()
        watcher = registered.watcher
        hostedStore = registered.hostedStore
      }
      createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })

    // Stop the watcher's timer and close every hosted session on quit, so a
    // closing app leaves no `gh`/`git` spawn (#80) or `claude` child (#98)
    // behind — `before-quit` fires on every platform, unlike
    // `window-all-closed`, which macOS's dock-icon convention skips.
    app.on('before-quit', () => {
      watcher?.stop()
      void hostedStore?.closeAll()
    })
  }
}

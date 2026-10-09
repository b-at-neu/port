import { app, BrowserWindow } from 'electron'
import { isAbsolute, join } from 'node:path'
import { registerIpc } from './ipc'
import { registerFixtureIpc } from './fixtures'
import { fixtureMode } from './fixtures/mode'
import type { PipelineWatcher } from './state/watcher'
import type { HostedStore } from './hosting/store'
import { createQuitGuard } from './dispatch/quit'
import type { Dispatcher } from './dispatch/dispatcher'
import { confirmQuit } from './dialogs'
import { applyNavigationGuards } from './navigation'
import { ABOUT_NOTICE, ABOUT_POWERED_BY } from '../shared/about/copy'

// A dev-only `pnpm install` never runs as root, so `chrome-sandbox` ships without the root-owned
// permissions Chromium requires. Packaged builds are unaffected.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox')
}

// An `on` result relocates `userData` before the single-instance lock is ever requested, so a
// fixture run never contends for the operator's own lock or touches their real profile.
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
    let dispatcher: Dispatcher | null = null
    let shutdownDispatch: (() => void) | null = null

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
        title: 'port',
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

      // On Windows/Linux, closing the last window quits the app, so it uses the same quit guard.
      if (process.platform !== 'darwin') {
        window.on('close', (event) => {
          if (quitGuard.intercept(() => event.preventDefault())) return
        })
      }

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
      // Never `app.setName('port')` here — that would move the dev
      // `userData` directory away from the operator's real profile.
      app.setAboutPanelOptions({ applicationName: 'port', applicationVersion: app.getVersion(), credits: [ABOUT_POWERED_BY, ABOUT_NOTICE].join('\n') })

      // Fixture mode starts neither a watcher nor a hosted-session store — both stay `null`, so
      // `before-quit` below no-ops for them.
      if (fixture.kind === 'on') {
        registerFixtureIpc(fixture.scenario)
      } else {
        const registered = registerIpc()
        watcher = registered.watcher
        hostedStore = registered.hostedStore
        dispatcher = registered.dispatcher
        shutdownDispatch = registered.shutdownDispatch
      }
      createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })

    // Intercepts `before-quit` and (off darwin) the main window's own `close` while any stage
    // session is still live, naming each one before the operator confirms.
    const quitGuard = createQuitGuard({
      sessions: () => dispatcher?.liveStageSessions() ?? [],
      confirm: (copy) => confirmQuit(mainWindow, copy),
      quit: () => app.quit(),
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })

    // `before-quit` fires on every platform, unlike `window-all-closed`, which macOS's dock-icon
    // convention skips. The quit guard runs first, and shutdown below runs only once it resolves.
    app.on('before-quit', (event) => {
      if (quitGuard.intercept(() => event.preventDefault())) return
      shutdownDispatch?.()
      watcher?.stop()
      void hostedStore?.closeAll()
    })
  }
}

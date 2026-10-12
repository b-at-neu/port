import { app, BrowserWindow, Menu } from 'electron'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { registerIpc, broadcastAppCommand } from '@/main/ipc'
import { registerFixtureIpc } from '@/main/fixtures'
import { fixtureMode } from '@/main/fixtures/mode'
import { e2eMode } from '@/main/e2e/mode'
import { setE2ERoute } from '@/main/platform/run'
import type { PipelineWatcher } from '@/types/state'
import type { HostedStore } from '@/types/hosting'
import { createQuitGuard } from '@/main/dispatch/quit'
import type { Dispatcher } from '@/types/dispatch'
import { confirmQuit } from '@/main/dialogs'
import { applyNavigationGuards } from '@/main/navigation'
import { ABOUT_NOTICE, ABOUT_POWERED_BY } from '@/utils/about/copy'
import { menuTemplate } from '@/main/menu'
import { chromeSandboxPath, needsNoSandbox } from '@/main/sandbox'
import type { StageRegistry } from '@/types/stage'

// A hung registry write must never block quitting.
const MARK_ALL_QUIT_TIMEOUT_MS = 2_000

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  const deadline = new Promise<void>((resolve) => {
    AbortSignal.timeout(ms).addEventListener('abort', () => resolve(), { once: true })
  })
  return Promise.race([promise, deadline])
}

// A misconfigured `chrome-sandbox` helper (see `ensure-sandbox.mjs`) falls back to `--no-sandbox`;
// once it's root:4755, the real sandbox runs instead, which AppArmor-hardened distros require.
if (!app.isPackaged && process.platform === 'linux') {
  let stat: { uid: number; mode: number } | null = null
  try {
    const result = statSync(chromeSandboxPath(process.execPath), { throwIfNoEntry: false })
    stat = result ? { uid: result.uid, mode: result.mode } : null
  } catch {
    stat = null
  }
  if (needsNoSandbox(process.platform, app.isPackaged, stat)) {
    app.commandLine.appendSwitch('no-sandbox')
  }
}

// An `on` result relocates `userData` before the single-instance lock is ever requested, so a
// fixture run never contends for the operator's own lock or touches their real profile.
const fixture = fixtureMode(process.env, app.isPackaged, isAbsolute)
const e2e = e2eMode(process.env, app.isPackaged, isAbsolute)

if (fixture.kind === 'invalid') {
  console.error(`[fixtures] ${fixture.reason}`)
  app.exit(1)
} else if (e2e.kind === 'invalid') {
  console.error(`[e2e] ${e2e.reason}`)
  app.exit(1)
} else {
  if (fixture.kind === 'ignored') {
    console.warn('[fixtures] PORT_FIXTURES is set but ignored in a packaged build')
  }
  if (fixture.kind === 'on') {
    app.setPath('userData', fixture.userData)
  }
  if (e2e.kind === 'ignored') {
    console.warn('[e2e] PORT_E2E is set but ignored in a packaged build')
  }
  if (e2e.kind === 'on') {
    app.setPath('userData', e2e.userData)
    setE2ERoute({ fake: e2e.fake })
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
    let stageRegistry: StageRegistry | null = null

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
        stageRegistry = registered.stageRegistry
      }
      Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, app.isPackaged, broadcastAppCommand)))
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
      const marked = stageRegistry !== null ? withTimeout(stageRegistry.markAllQuit(), MARK_ALL_QUIT_TIMEOUT_MS) : Promise.resolve()
      void marked.then(() => hostedStore?.closeAll())
    })
  }
}

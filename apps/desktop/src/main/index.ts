import { app, BrowserWindow, Menu } from 'electron'
import { isAbsolute, join } from 'node:path'
import { devDockIconPath, windowIconPath } from '@/main/icon'
import { registerIpc, broadcastAppCommand } from '@/main/ipc'
import { registerFixtureIpc } from '@/main/fixtures'
import { fixtureMode } from '@/main/fixtures/mode'
import { e2eMode } from '@/main/e2e/mode'
import { setE2ERoute } from '@/main/platform/run'
import { statOwnerMode, pathExists } from '@/main/platform/files'
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

// A misconfigured `chrome-sandbox` helper falls back to `--no-sandbox`; once it's root:4755
// the real sandbox runs instead, which AppArmor-hardened distros require (see ensure-sandbox.mjs).
async function configureSandboxSwitch(): Promise<void> {
  if (app.isPackaged || process.platform !== 'linux') return
  const stat = await statOwnerMode(chromeSandboxPath(process.execPath))
  if (needsNoSandbox(process.platform, app.isPackaged, stat)) {
    app.commandLine.appendSwitch('no-sandbox')
  }
}

// Resolved before `app.whenReady()` below — `commandLine.appendSwitch` is a no-op once ready.
const sandboxConfigured = configureSandboxSwitch()

// `app.setName()` changes Electron's own Linux app_id/WM_CLASS at runtime — `syncDesktopName`
// only renames the *installed* `.desktop` file, which `pnpm dev` never touches.
const defaultUserDataPath = app.getPath('userData')
app.setName('port')
// Renaming moves the default `userData` path too, so the pre-rename path is pinned back right away.
app.setPath('userData', defaultUserDataPath)

// An `on` result relocates `userData` before the single-instance lock is ever requested, so a
// fixture run never contends for the operator's own lock or touches their real profile.
const fixture = fixtureMode(process.env, app.isPackaged, __PORT_PACKAGED_FIXTURES__, isAbsolute)
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

    async function createWindow(): Promise<void> {
      const iconPath = windowIconPath({ platform: process.platform, isPackaged: app.isPackaged, mainDir: __dirname, resourcesPath: process.resourcesPath })
      // A missing file (e.g. `electron-vite dev` run directly, skipping `icon.mjs`) must not
      // crash dev — fall back to Electron's own default icon, silently.
      const icon = iconPath !== null && (await pathExists(iconPath)) ? iconPath : null

      const window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'port',
        show: false,
        ...(icon !== null ? { icon } : {}),
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

    void sandboxConfigured.then(() => app.whenReady()).then(async () => {
      app.setAboutPanelOptions({ applicationName: 'port', applicationVersion: app.getVersion(), credits: [ABOUT_POWERED_BY, ABOUT_NOTICE].join('\n') })

      const dockIconPath = devDockIconPath({ platform: process.platform, isPackaged: app.isPackaged, mainDir: __dirname, resourcesPath: process.resourcesPath })
      if (dockIconPath !== null && (await pathExists(dockIconPath))) {
        app.dock?.setIcon(dockIconPath)
      }

      // Fixture mode starts neither a watcher nor a hosted-session store — both stay `null`, so
      // `before-quit` below no-ops for them.
      if (fixture.kind === 'on') {
        registerFixtureIpc(fixture.scenario)
        // The fixture case only needs the menu to render — no store to read sessions or marks from.
        Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, app.isPackaged, [], broadcastAppCommand)))
      } else {
        // registerIpc builds the real initial menu itself, from the hosted store it just created.
        const registered = registerIpc()
        watcher = registered.watcher
        hostedStore = registered.hostedStore
        dispatcher = registered.dispatcher
        shutdownDispatch = registered.shutdownDispatch
        stageRegistry = registered.stageRegistry
      }
      Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, app.isPackaged, [], broadcastAppCommand)))
      void createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow()
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

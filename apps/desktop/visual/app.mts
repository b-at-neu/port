// Launch, theme, settle and capture helpers for the visual harness (#317) —
// `_electron.launch` drives the real built app (`out/main/index.js`) in
// fixture mode, never a second copy of the renderer. `.mts`, not `.ts`:
// Playwright's own test transform respects the nearest `package.json`'s
// `type` field, and `apps/desktop/package.json` deliberately carries none
// (CONTRIBUTING.md → "Working on the desktop app") — an explicit ESM
// extension is what lets `import.meta.url` below actually run as ESM rather
// than failing under a CommonJS transpile.
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// `playwright-core`, never the full `playwright` package — the Electron
// driver needs no downloaded browser binary, and `playwright-core` ships
// with no browser-download install step at all.
import { _electron } from 'playwright-core'
import type { ElectronApplication, Page } from 'playwright-core'
import { FIXTURE_ENV } from '../src/main/fixtures/mode'
// `.mjs`, matching this `.mts` file's own emitted-ESM specifier rules — a
// relative import from a `.mts` module must name the extension Node would
// actually resolve, not the source extension.
import type { Target, Theme } from './targets.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_ENTRY = join(HERE, '..', 'out', 'main', 'index.js')
const WAIT_TIMEOUT_MS = 10_000

export interface FixtureApp {
  readonly app: ElectronApplication
  readonly page: Page
  close(): Promise<void>
}

/** Fails fast with the actual remedy rather than a Playwright launch error
 *  an agent would have to decode. */
export async function launchFixtureApp(): Promise<FixtureApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error('Built app not found. Run `pnpm screenshots`, which builds first.')
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'port-visual-'))

  // `process.env` plus both `FIXTURE_ENV` keys, minus `ELECTRON_RENDERER_URL`
  // and `ELECTRON_RUN_AS_NODE` — built field by field, since Electron's own
  // `env` option takes `Record<string, string>`, never `| undefined`.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env[FIXTURE_ENV.flag] = '1'
  env[FIXTURE_ENV.userData] = userDataDir
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']

  // Requiring the `electron` package from plain Node (never from inside
  // Electron itself) resolves to the packaged binary's own path — the same
  // resolution `scripts/ensure-electron.mjs` already relies on.
  const electronBinary = createRequire(import.meta.url)('electron') as unknown as string

  const electronApp = await _electron.launch({
    executablePath: electronBinary,
    args: ['--force-device-scale-factor=1', MAIN_ENTRY],
    env,
  })

  const page = await electronApp.firstWindow()
  await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800)
  })

  return {
    app: electronApp,
    page,
    async close() {
      await electronApp.close()
      await rm(userDataDir, { recursive: true, force: true })
    },
  }
}

/** Forces the renderer's `prefers-color-scheme` media feature directly
 *  (Playwright's Electron `Page` exposes the same CDP emulation a browser
 *  `Page` does), then waits for `theme/store.ts`'s own `apply()` to catch
 *  up. Chromium fires the `MediaQueryList` `'change'` listener `apply()`
 *  is subscribed through, the same as a real OS theme change would — but
 *  this never depends on `nativeTheme.themeSource` actually reaching the
 *  renderer, which CI's `xvfb` runner has no GTK/theme-portal to carry
 *  (#317 review: `board · dark` timed out here under real CI, not just an
 *  implementer's sandbox). */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme })

  try {
    await page.waitForFunction((value: Theme) => document.documentElement.dataset.theme === value, theme, { timeout: WAIT_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`theme '${theme}' never applied to the document — ${String(error)}`, { cause: error })
  }
}

/** Navigates to a capture target's own hash, then waits for its container,
 *  its `ready` selector, every skeleton inside that container to clear, web
 *  fonts, and two animation frames — in that order, each bounded to
 *  `WAIT_TIMEOUT_MS` and naming the target on timeout. */
export async function settle(page: Page, target: Extract<Target, { readonly kind: 'capture' }>): Promise<void> {
  await page.evaluate((hash: string) => {
    location.hash = hash
  }, target.hash)

  try {
    await page.locator(target.container).first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`${target.hash}: container '${target.container}' never became visible — ${String(error)}`, { cause: error })
  }

  try {
    await page.locator(target.ready).first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`${target.hash}: ready selector '${target.ready}' never became visible — ${String(error)}`, { cause: error })
  }

  try {
    await page
      .locator(`${target.container} [data-slot="skeleton"]`)
      .first()
      .waitFor({ state: 'detached', timeout: WAIT_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`${target.hash}: a skeleton never cleared inside '${target.container}' — ${String(error)}`, { cause: error })
  }

  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

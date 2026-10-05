// Packaged-binary smoke test — launches the real electron-builder output, never the dev build, with fixtures deliberately off (a packaged build ignores `PORT_FIXTURES` by design, `src/main/fixtures/mode.ts`).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import type { ConsoleMessage } from 'playwright-core'
import { _electron } from 'playwright-core'
import { FIXTURE_ENV } from '../src/main/fixtures/mode.js'
import { packagedExecutable } from './binary.mjs'

test.describe.configure({ mode: 'serial' })

const WAIT_TIMEOUT_MS = 15_000

test('packaged app launches, mounts and quits cleanly', async () => {
  const executablePath = packagedExecutable()
  const userDataDir = await mkdtemp(join(tmpdir(), 'port-smoke-'))

  // The run must not depend on anything but the packaged binary itself.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env[FIXTURE_ENV.flag]
  delete env[FIXTURE_ENV.userData]
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']

  const errors: string[] = []

  try {
    const app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      env,
    })

    try {
      // Bind on the 'window' event, not after `firstWindow()` resolves — the latter awaits the
      // page's load state first, so an error thrown during that very early load would be missed.
      app.on('window', (window) => {
        window.on('pageerror', (error: Error) => errors.push(error.message))
        window.on('console', (message: ConsoleMessage) => {
          if (message.type() === 'error') errors.push(message.text())
        })
      })
      const page = await app.firstWindow()

      // `#app` is the always-present shell element, unlike `#react-root`, which stays hidden until a React-only screen mounts.
      await page.locator('#app').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT_MS })

      const isPackaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)
      expect(isPackaged, 'launched binary reports app.isPackaged === true — this must never run the dev build').toBe(true)

      if (errors.length > 0) {
        throw new Error(`packaged launch hit a page or console error: ${errors.join('; ')}`)
      }

      await Promise.race([
        app.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('app.close() timed out')), WAIT_TIMEOUT_MS)),
      ])
    } catch (error) {
      await app.close().catch(() => undefined)
      throw error
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

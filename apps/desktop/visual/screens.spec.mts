// One test per route × theme (#317) — serial mode, one app launch for the
// whole file, so every capture sees the same fixture data without paying for
// a fresh Electron launch per screenshot. `beforeAll` clears and recreates
// `SCREENSHOT_DIR`, so a route removed from `targets.mts` never leaves a
// stale PNG behind.
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@playwright/test'
import type { ConsoleMessage } from 'playwright-core'
// `.mjs`, matching `app.mts`'s and `targets.mts`'s own emitted-ESM specifier
// rules — see `app.mts`'s own note on this.
import { launchFixtureApp, settle, setTheme } from './app.mjs'
import type { FixtureApp } from './app.mjs'
import { SCREENSHOT_DIR, SCREENSHOT_TARGETS, THEMES, VARIANT_TARGETS } from './targets.mjs'

test.describe.configure({ mode: 'serial' })

let fixture: FixtureApp
let pageErrors: string[] = []

test.beforeAll(async () => {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true })
  await mkdir(SCREENSHOT_DIR, { recursive: true })

  fixture = await launchFixtureApp()
  fixture.page.on('pageerror', (error: Error) => pageErrors.push(error.message))
  fixture.page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
})

test.afterAll(async () => {
  await fixture.close()
})

test.beforeEach(() => {
  pageErrors = []
})

// A test that threw (including this project's own "quotes the error"
// throws below) is the one case worth a screenshot — a passing test needs
// no evidence, and `failure.png` would otherwise accumulate for green runs.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
    await fixture.page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => undefined)
  }
})

for (const [key, target] of Object.entries(SCREENSHOT_TARGETS)) {
  for (const theme of THEMES) {
    test(`${key} · ${theme}`, async () => {
      await setTheme(fixture.page, theme)
      await settle(fixture.page, target)

      if (pageErrors.length > 0) {
        throw new Error(`'${key} · ${theme}' hit a page or console error: ${pageErrors.join('; ')}`)
      }

      await fixture.page.screenshot({ path: join(SCREENSHOT_DIR, `${key}-${theme}.png`), animations: 'disabled', caret: 'hide' })
    })

    for (const variant of target.variants ?? []) {
      test(`${key} · ${variant.name} · ${theme}`, async () => {
        await setTheme(fixture.page, theme)
        await settle(fixture.page, target, variant)

        if (pageErrors.length > 0) {
          throw new Error(`'${key} · ${variant.name} · ${theme}' hit a page or console error: ${pageErrors.join('; ')}`)
        }

        await fixture.page.screenshot({ path: join(SCREENSHOT_DIR, `${key}-${variant.name}-${theme}.png`), animations: 'disabled', caret: 'hide' })
      })
    }
  }
}

// Scenario-variant captures — one Electron launch per distinct scenario, so
// each screenshot shows that variant's own fixture data, not the defaults.
const VARIANT_SCENARIOS = [...new Set(VARIANT_TARGETS.map((variant) => variant.scenario))]

for (const scenario of VARIANT_SCENARIOS) {
  test.describe(`scenario variants · ${scenario}`, () => {
    test.describe.configure({ mode: 'serial' })

    let variantFixture: FixtureApp
    let variantPageErrors: string[] = []

    test.beforeAll(async () => {
      variantFixture = await launchFixtureApp(scenario)
      variantFixture.page.on('pageerror', (error: Error) => variantPageErrors.push(error.message))
      variantFixture.page.on('console', (message: ConsoleMessage) => {
        if (message.type() === 'error') variantPageErrors.push(message.text())
      })
    })

    test.afterAll(async () => {
      await variantFixture.close()
    })

    test.beforeEach(() => {
      variantPageErrors = []
    })

    test.afterEach(async ({}, testInfo) => {
      if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
        await variantFixture.page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => undefined)
      }
    })

    for (const variant of VARIANT_TARGETS.filter((v) => v.scenario === scenario)) {
      for (const theme of THEMES) {
        test(`${variant.name} · ${theme}`, async () => {
          await setTheme(variantFixture.page, theme)
          await settle(variantFixture.page, variant.target)

          if (variantPageErrors.length > 0) {
            throw new Error(`'${variant.name} · ${theme}' hit a page or console error: ${variantPageErrors.join('; ')}`)
          }

          await variantFixture.page.screenshot({ path: join(SCREENSHOT_DIR, `${variant.name}-${theme}.png`), animations: 'disabled', caret: 'hide' })
        })
      }
    }
  })
}

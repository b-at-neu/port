// Flow 3: Run, stop, and drain a pipeline from the status-pill menu.
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { assertNoDisallowedCalls, launchE2EApp } from './harness/app.mjs'
import type { E2EApp } from './harness/app.mjs'
import { sandboxState } from './fake/state.mjs'

// Every dispatch control ends in a forced refresh through the spawned fakes, which a slow runner can stretch past the 5s default.
const CONTROL_SETTLE_MS = 30_000

let harness: E2EApp

interface DispatchFileShape {
  readonly repositories: ReadonlyArray<{ readonly state: string }>
}

async function dispatchState(dispatchPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(dispatchPath, 'utf8')
    const parsed = JSON.parse(raw) as DispatchFileShape
    return parsed.repositories[0]?.state
  } catch {
    return undefined
  }
}

test.beforeEach(async () => {
  harness = await launchE2EApp({
    state: sandboxState({ viewer: 'octocat', repo: 'acme/widgets' }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('runs, stops, and drains a pipeline, with Drain disabled while nothing is in flight', async () => {
  const { app, page } = harness
  const userDataPath = await app.evaluate(({ app: electronApp }: typeof import('electron')) => electronApp.getPath('userData'))
  const dispatchPath = `${userDataPath}/dispatch.json`

  const pill = page.getByRole('button', { name: /^Stopped$/ }).first()
  await pill.click()
  await expect(page.getByRole('menuitem', { name: 'Drain' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: 'Run' })).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  await pill.click()
  await page.getByRole('menuitem', { name: 'Run' }).click()
  const runningPill = page.getByRole('button', { name: /^Running$/ }).first()
  await expect(runningPill).toBeVisible({ timeout: CONTROL_SETTLE_MS })
  expect(await dispatchState(dispatchPath)).toBe('dispatching')

  await runningPill.click()
  await page.getByRole('menuitem', { name: 'Stop' }).click()
  const stoppedPill = page.getByRole('button', { name: /^Stopped$/ }).first()
  await expect(stoppedPill).toBeVisible({ timeout: CONTROL_SETTLE_MS })
  expect(await dispatchState(dispatchPath)).toBe('paused')

  await stoppedPill.click()
  await page.getByRole('menuitem', { name: 'Run' }).click()
  await expect(runningPill).toBeVisible({ timeout: CONTROL_SETTLE_MS })

  await runningPill.click()
  await page.getByRole('menuitem', { name: 'Drain' }).click()
  const drainedPill = page.getByRole('button', { name: /^Stopped$/ }).first()
  await expect(drainedPill).toBeVisible({ timeout: CONTROL_SETTLE_MS })
  expect(await dispatchState(dispatchPath)).toBe('draining')

  await drainedPill.click()
  await expect(page.getByRole('menuitem', { name: 'Drain' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: 'Run' })).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  const calls = await harness.calls()
  expect(calls.some((call) => call.command === 'claude' && JSON.stringify(call.args) !== JSON.stringify(['--version']))).toBe(false)
})

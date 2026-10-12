// Flow 3: Run, pause, and drain a pipeline from the status-pill menu.
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { assertNoDisallowedCalls, launchE2EApp } from './harness/app.mjs'
import type { E2EApp } from './harness/app.mjs'
import { sandboxState } from './fake/state.mjs'

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

test('runs, pauses, and drains a pipeline, with Drain disabled while nothing is in flight', async () => {
  const { app, page } = harness
  const userDataPath = await app.evaluate(({ app: electronApp }: typeof import('electron')) => electronApp.getPath('userData'))
  const dispatchPath = `${userDataPath}/dispatch.json`

  const pill = page.getByRole('button', { name: /^Paused$/ }).first()
  await pill.click()
  await expect(page.getByRole('menuitem', { name: 'Drain' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: 'Run' })).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  await pill.click()
  await page.getByRole('menuitem', { name: 'Run' }).click()
  const runningPill = page.getByRole('button', { name: /^Running$/ }).first()
  await expect(runningPill).toBeVisible()
  expect(await dispatchState(dispatchPath)).toBe('dispatching')

  await runningPill.click()
  await page.getByRole('menuitem', { name: 'Pause' }).click()
  const pausedPill = page.getByRole('button', { name: /^Paused$/ }).first()
  await expect(pausedPill).toBeVisible()
  expect(await dispatchState(dispatchPath)).toBe('paused')

  await pausedPill.click()
  await page.getByRole('menuitem', { name: 'Run' }).click()
  await expect(runningPill).toBeVisible()

  await runningPill.click()
  await page.getByRole('menuitem', { name: 'Drain' }).click()
  const drainingPill = page.getByRole('button', { name: /^Draining$/ }).first()
  await expect(drainingPill).toBeVisible()
  expect(await dispatchState(dispatchPath)).toBe('draining')

  const calls = await harness.calls()
  expect(calls.some((call) => call.command === 'claude' && JSON.stringify(call.args) !== JSON.stringify(['--version']))).toBe(false)
})

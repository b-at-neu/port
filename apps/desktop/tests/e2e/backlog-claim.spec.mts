// Flow 1: Work on a ticket from the Backlog.
import { expect, test } from '@playwright/test'
import { assertNoDisallowedCalls, launchE2EApp } from './harness/app.mjs'
import type { E2EApp } from './harness/app.mjs'
import { sandboxState } from './fake/state.mjs'

let harness: E2EApp

test.beforeEach(async () => {
  harness = await launchE2EApp({
    state: sandboxState({
      viewer: 'octocat',
      repo: 'acme/widgets',
      issues: [{ number: 101, title: 'Fix the thing', labels: [] }],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('claims an unlabelled backlog issue, and the first row starts unhighlighted', async () => {
  const { page } = harness

  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const row = page.locator('[data-slot="backlog-row"]').first()
  await row.waitFor({ state: 'visible' })

  // The regression: before any keyboard input, nothing in the list is focus-highlighted.
  await expect(row).not.toHaveClass(/ring-2/)

  await row.getByRole('button', { name: 'Work on' }).click()
  await page.getByRole('menuitem', { name: 'Review the plan' }).click()

  await expect(page.getByRole('dialog')).toContainText('#101')
  await page.getByRole('button', { name: 'Claim', exact: true }).click()

  await expect(page.getByRole('dialog')).toContainText('claimed')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('[data-slot="backlog-row"]')).toHaveCount(0)

  const calls = await harness.calls()
  const editCalls = calls.filter((call) => call.command === 'gh' && call.args[0] === 'issue' && call.args[1] === 'edit' && call.args[2] === '101')
  expect(editCalls).toHaveLength(1)
  expect(editCalls[0]?.args).toContain('--add-label')

  const state = await harness.state()
  const issue = state.issues.find((i) => i.number === 101)
  expect(issue?.labels).toContain('ready')
  expect(issue?.labels).toContain('claude')
})

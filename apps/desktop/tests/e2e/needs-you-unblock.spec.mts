// Flow 2: Unblock from Needs you — the comment lands before the label swap.
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
      pulls: [{ number: 202, title: 'Add the thing', labels: ['needs human'], assignees: ['octocat'] }],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('unblocks a needs-human PR, removing the label and posting Gate cleared, in order', async () => {
  const { page } = harness

  await page.getByRole('link', { name: /^Needs you/ }).click()

  await expect(page.getByText('#202').first()).toBeVisible()
  await page.getByRole('button', { name: 'Unblock' }).first().click()

  await expect(page.getByRole('dialog')).toContainText('#202')
  await page.getByRole('button', { name: 'Send to review' }).click()

  await expect(page.getByRole('dialog')).toContainText('unblocked', { timeout: 15_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('[data-slot="needs-you-empty"]')).toBeVisible()

  const calls = await harness.calls()
  const editIndex = calls.findIndex((call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'edit' && call.args[2] === '202')
  const commentIndex = calls.findIndex((call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'comment' && call.args[2] === '202')

  expect(commentIndex).toBeGreaterThanOrEqual(0)
  expect(editIndex).toBeGreaterThan(commentIndex)
  expect(calls[editIndex]?.args).toContain('--remove-label')

  const state = await harness.state()
  const pull = state.pulls.find((p) => p.number === 202)
  expect(pull?.labels).not.toContain('needs human')
  expect(pull?.comments?.at(-1)).toContain('## Gate cleared')
})

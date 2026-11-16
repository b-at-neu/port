// Flow: Request changes from Needs you — the note is posted before the approved → needs revision label swap.
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
      pulls: [{ number: 202, title: 'Add the thing', labels: ['approved'], assignees: ['octocat'], headRefOid: 'abc1234def5678' }],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('sends an approved PR back to revision, posting the note before swapping labels', async () => {
  const { page } = harness
  const note = 'Rename the helper to something clearer'

  await page.getByRole('link', { name: /^Needs you/ }).click()

  await expect(page.getByText('#202').first()).toBeVisible()
  await page.getByRole('button', { name: 'Request changes' }).first().click()

  await expect(page.getByRole('dialog')).toContainText('#202')
  await page.getByRole('textbox').fill(note)
  await page.getByRole('button', { name: 'Send back to revision' }).click()

  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('[data-sonner-toast]')).toContainText('needs revision', { timeout: 15_000 })

  const calls = await harness.calls()
  const commentIndex = calls.findIndex((call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'comment' && call.args[2] === '202')
  const editIndex = calls.findIndex((call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'edit' && call.args[2] === '202')

  expect(commentIndex).toBeGreaterThanOrEqual(0)
  expect(editIndex).toBeGreaterThan(commentIndex)
  expect(calls[editIndex]?.args).toContain('--remove-label')
  expect(calls[editIndex]?.args).toContain('--add-label')

  const state = await harness.state()
  const pull = state.pulls.find((p) => p.number === 202)
  expect(pull?.labels).not.toContain('approved')
  expect(pull?.labels).toContain('needs revision')
  expect(pull?.comments?.[0]).toMatch(/^## Changes requested/)
  expect(pull?.comments?.[0]).toContain(note)
})

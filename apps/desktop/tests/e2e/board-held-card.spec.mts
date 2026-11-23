// A held pull request says so on its Board card, with the same sentence the detail pane prints.
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
      issues: [{ number: 300, title: 'Tune the cache', labels: ['claude', 'in progress'], assignees: ['octocat'] }],
      pulls: [{ number: 301, title: 'Tune the cache', labels: ['claude', 'ready for review'], assignees: ['someone-else'], body: 'Closes #300' }],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('shows why a held pull request is held on its kanban card and in the pane', async () => {
  const { page } = harness
  const sentence = '#301 assigned to someone else.'

  await page.evaluate(() => {
    window.location.hash = '#/board?view=board'
  })

  const tag = page.locator('[data-slot="ticket-card"] [data-slot="held-tag"]')
  await expect(tag).toHaveText("Held · someone else's")

  await tag.hover()
  await expect(page.getByRole('tooltip')).toContainText(sentence)

  await page.locator('[data-slot="ticket-card"]').click()
  await expect(page.getByRole('complementary').getByText(sentence)).toBeVisible()
})

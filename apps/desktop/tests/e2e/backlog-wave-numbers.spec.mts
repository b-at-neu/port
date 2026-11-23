// Flow: a wave number keeps naming the same group of tickets after earlier tickets merge, so a closed first wave leaves a gap instead of renumbering.
import { expect, test } from '@playwright/test'
import { assertNoDisallowedCalls, launchE2EApp } from './harness/app.mjs'
import type { E2EApp } from './harness/app.mjs'
import { sandboxState } from './fake/state.mjs'

let harness: E2EApp

const issue = (number: number, state: 'OPEN' | 'CLOSED') => ({ number, title: `Ticket ${String(number)}`, url: `https://github.com/acme/widgets/issues/${String(number)}`, state })

test.beforeEach(async () => {
  harness = await launchE2EApp({
    state: sandboxState({
      viewer: 'octocat',
      repo: 'acme/widgets',
      issues: [
        { number: 300, title: 'Ship the thing', labels: [], createdAt: '2024-02-01T00:00:00Z' },
        { number: 301, title: 'Done first step', labels: [], state: 'CLOSED', parent: 300 },
        { number: 302, title: 'Second step', labels: [], parent: 300, blockedBy: [issue(301, 'CLOSED')] },
        { number: 303, title: 'Third step', labels: [], parent: 300, blockedBy: [issue(302, 'OPEN')] },
      ],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('starts at Wave 2 when the first wave is closed, and shows no uncertainty note', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const epic = page.locator('[data-slot="backlog-epic"][data-epic="300"]')
  await expect(epic).toBeVisible()

  await expect(epic.locator('[data-slot="backlog-wave"][data-wave="1"]')).toHaveCount(0)
  await expect(epic.locator('[data-slot="backlog-wave"][data-wave="2"] [data-slot="backlog-row"]')).toContainText('#302')
  await expect(epic.locator('[data-slot="backlog-wave"][data-wave="3"] [data-slot="backlog-row"]')).toContainText('#303')
  await expect(epic.locator('[data-slot="backlog-wave-note"]')).toHaveCount(0)
})

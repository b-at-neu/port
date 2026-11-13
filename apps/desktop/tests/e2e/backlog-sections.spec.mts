// Flow: collapse a Backlog section, filter repositories, and keep both across a reload.
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
      issues: [
        { number: 101, title: 'Fix the thing', labels: [] },
        { number: 102, title: 'Tidy the other thing', labels: [] },
        { number: 103, title: 'Ship the follow-up', labels: [] },
      ],
    }),
    extraRepos: ['acme/gadgets'],
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

test('collapses a section, skips it with the keyboard, and keeps it collapsed after a reload', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const widgets = page.locator('[data-slot="backlog-group"][data-repo="acme/widgets"]')
  const gadgets = page.locator('[data-slot="backlog-group"][data-repo="acme/gadgets"]')
  await expect(widgets.locator('[data-slot="backlog-row"]')).toHaveCount(3)
  await expect(gadgets.locator('[data-slot="backlog-row"]')).toHaveCount(3)

  await widgets.getByRole('button', { name: 'Collapse acme/widgets' }).click()
  await expect(widgets.locator('[data-slot="backlog-row"]')).toHaveCount(0)
  await expect(widgets.getByRole('button', { name: 'Expand acme/widgets' })).toContainText('acme/widgets · 3')

  await page.keyboard.press('j')
  await expect(gadgets.locator('[data-slot="backlog-row"].ring-2')).toHaveCount(1)
  await expect(widgets.locator('[data-slot="backlog-row"].ring-2')).toHaveCount(0)

  await harness.relaunch()
  const relaunched = harness.page
  await relaunched.getByRole('link', { name: 'Backlog', exact: true }).click()
  const widgetsAfter = relaunched.locator('[data-slot="backlog-group"][data-repo="acme/widgets"]')
  const gadgetsAfter = relaunched.locator('[data-slot="backlog-group"][data-repo="acme/gadgets"]')
  await expect(gadgetsAfter.locator('[data-slot="backlog-row"]')).toHaveCount(3)
  await expect(widgetsAfter).toHaveAttribute('data-collapsed', 'true')
  await expect(widgetsAfter.locator('[data-slot="backlog-row"]')).toHaveCount(0)
})

test('hides a repository from the filter, keeps it hidden after a reload, and restores it with Show all', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const gadgets = page.locator('[data-slot="backlog-group"][data-repo="acme/gadgets"]')
  await expect(gadgets).toBeVisible()

  const filter = page.locator('[data-slot="backlog-repo-filter"]')
  await expect(filter).toHaveText('Repositories')
  await filter.click()
  await page.getByRole('menuitemcheckbox', { name: 'acme/gadgets' }).click()
  await page.keyboard.press('Escape')

  await expect(gadgets).toHaveCount(0)
  await expect(filter).toHaveText('Repositories · 1 of 2')

  await harness.relaunch()
  const relaunched = harness.page
  await relaunched.getByRole('link', { name: 'Backlog', exact: true }).click()
  const filterAfter = relaunched.locator('[data-slot="backlog-repo-filter"]')
  const gadgetsAfter = relaunched.locator('[data-slot="backlog-group"][data-repo="acme/gadgets"]')
  await expect(filterAfter).toHaveText('Repositories · 1 of 2')
  await expect(gadgetsAfter).toHaveCount(0)

  await filterAfter.click()
  await relaunched.getByRole('menuitem', { name: 'Show all' }).click()
  await expect(gadgetsAfter).toBeVisible()
  await expect(filterAfter).toHaveText('Repositories')
})

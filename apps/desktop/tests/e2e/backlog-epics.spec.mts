// Flow: an epic renders as ordered waves, collapses, and keeps keyboard navigation and Work on.
import { expect, test } from '@playwright/test'
import { assertNoDisallowedCalls, launchE2EApp } from './harness/app.mjs'
import type { E2EApp } from './harness/app.mjs'
import { sandboxState } from './fake/state.mjs'

let harness: E2EApp

const issue = (number: number) => ({ number, title: `Ticket ${String(number)}`, url: `https://github.com/acme/widgets/issues/${String(number)}`, state: 'OPEN' })

test.beforeEach(async () => {
  harness = await launchE2EApp({
    state: sandboxState({
      viewer: 'octocat',
      repo: 'acme/widgets',
      issues: [
        { number: 200, title: 'Ship the thing', labels: [] },
        { number: 201, title: 'First step', labels: [], parent: 200 },
        { number: 202, title: 'Second step', labels: ['claude', 'in progress'], parent: 200, blockedBy: [issue(201)] },
        { number: 203, title: 'Third step', labels: [], parent: 200, blockedBy: [issue(202)] },
        { number: 205, title: 'Already done', labels: [], state: 'CLOSED', parent: 200 },
        { number: 210, title: 'Unrelated', labels: [] },
      ],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

async function selectedNumber(page: E2EApp['page']): Promise<string | null> {
  const selected = page.locator('[data-row-key].ring-2')
  await expect(selected).toHaveCount(1)
  return selected.getAttribute('data-row-key')
}

test('renders the epic as waves with a band, then the flat rows', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const epic = page.locator('[data-slot="backlog-epic"][data-epic="200"]')
  const epicRow = epic.locator('[data-slot="backlog-epic-row"]')
  await expect(epicRow).toContainText('#200')
  await expect(epicRow).toContainText('Epic')
  await expect(epicRow.getByRole('progressbar')).toContainText('1/4')

  await expect(epic.locator('[data-slot="backlog-wave"][data-wave="1"] [data-slot="backlog-row"]')).toContainText('#201')
  const band = epic.locator('[data-slot="backlog-wave-band"]')
  await expect(band).toHaveText('Wave 2 · 1 in progress')
  await expect(band.locator('[data-slot="backlog-row"]')).toHaveCount(0)

  const waveThree = epic.locator('[data-slot="backlog-wave"][data-wave="3"]')
  await expect(waveThree.locator('[data-slot="backlog-row"]')).toContainText('#203')
  const blocked = waveThree.locator('[data-slot="backlog-blocked"]')
  await expect(blocked).toContainText('Blocked')
  await blocked.hover()
  await expect(page.getByRole('tooltip').first()).toContainText('#202')

  const flat = page.locator('[data-slot="backlog-row"]', { hasText: '#210' })
  await expect(flat).toBeVisible()
  await expect(epic.locator('[data-slot="backlog-row"]', { hasText: '#210' })).toHaveCount(0)
})

test('moves through the epic with J, then skips a collapsed epic', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  await expect(page.locator('[data-slot="backlog-epic"][data-epic="200"]')).toBeVisible()

  const expected = ['200', '201', '203', '210']
  for (const number of expected) {
    await page.keyboard.press('j')
    expect(await selectedNumber(page)).toMatch(new RegExp(`:${number}$`))
  }

  const epic = page.locator('[data-slot="backlog-epic"][data-epic="200"]')
  await epic.getByRole('button', { name: 'Collapse #200' }).click()
  await expect(epic).toHaveAttribute('data-collapsed', 'true')
  await expect(epic.locator('[data-slot="backlog-wave"]')).toHaveCount(0)
  await expect(epic.getByRole('button', { name: 'Expand #200' })).toHaveAttribute('aria-expanded', 'false')

  await epic.locator('[data-slot="backlog-epic-row"]').getByText('#200', { exact: true }).click()
  expect(await selectedNumber(page)).toMatch(/:200$/)
  await page.keyboard.press('j')
  expect(await selectedNumber(page)).toMatch(/:210$/)
})

test('keeps a collapsed epic collapsed after a relaunch', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const epic = page.locator('[data-slot="backlog-epic"][data-epic="200"]')
  await epic.getByRole('button', { name: 'Collapse #200' }).click()
  await expect(epic).toHaveAttribute('data-collapsed', 'true')

  await harness.relaunch()
  const relaunched = harness.page
  await relaunched.getByRole('link', { name: 'Backlog', exact: true }).click()
  await expect(relaunched.locator('[data-slot="backlog-epic"][data-epic="200"]')).toHaveAttribute('data-collapsed', 'true')
})

test('opens Work on from a sub-ticket and asks before claiming a blocked one', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const row = page.locator('[data-slot="backlog-wave"][data-wave="3"] [data-slot="backlog-row"]', { hasText: '#203' })
  await row.getByRole('button', { name: 'Work on' }).click()
  await page.getByRole('menuitem', { name: 'Review the plan' }).click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Start #203 anyway?')
  await expect(dialog.getByRole('link', { name: '#202 Ticket 202' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})

// Flow: a Backlog ticket and an epic expand into a detail panel, fetched once on first expand.
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
        { number: 200, title: 'Ship the thing', labels: [], body: 'Epic body', author: 'octocat' },
        { number: 201, title: 'First step', labels: [], parent: 200, body: '**First** step', author: 'alice', assignees: ['bob'] },
        { number: 203, title: 'Third step', labels: [], parent: 200, blockedBy: [issue(201)] },
        { number: 204, title: 'Fourth step', labels: [], parent: 200, detailError: 'Resource not accessible' },
      ],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

async function detailReads(number: number): Promise<number> {
  const calls = await harness.calls()
  return calls.filter((call) => JSON.stringify(call.args).includes(`issueOrPullRequest(number: ${String(number)})`)).length
}

test('expands a ticket, collapses it, and serves a re-expand from the cache', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#201' })
  await expect(row).toBeVisible()
  expect(await detailReads(201)).toBe(0)

  await row.getByRole('button', { name: 'Show details for #201' }).click()
  const panel = page.getByRole('region', { name: 'Details for #201' })
  await expect(panel.locator('strong')).toHaveText('First')
  await expect(panel.locator('[data-field="author"]')).toContainText('alice')
  await expect(panel.locator('[data-field="assignee"]')).toContainText('bob')
  await expect(panel.locator('[data-field="blocks"]').getByRole('link', { name: '#203' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Hide details for #201' })).toHaveAttribute('aria-expanded', 'true')
  expect(await detailReads(201)).toBe(1)

  await row.getByRole('button', { name: 'Hide details for #201' }).click()
  await expect(panel).toHaveCount(0)

  await row.getByRole('button', { name: 'Show details for #201' }).click()
  await expect(panel.locator('strong')).toHaveText('First')
  expect(await detailReads(201)).toBe(1)
})

test('opens the selected row with Space and lists its blocker', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#203' })
  await row.focus()
  await page.keyboard.press('Space')

  const panel = page.getByRole('region', { name: 'Details for #203' })
  await expect(panel.locator('[data-field="blocked-by"]')).toContainText('#201')
})

test('toggles the epic info panel independently of the epic', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const epic = page.locator('[data-slot="backlog-epic"][data-epic="200"]')

  await epic.getByRole('button', { name: 'Show info for #200' }).click()
  const panel = page.getByRole('region', { name: 'Details for #200' })
  await expect(panel).toContainText('Epic body')
  await expect(panel).toContainText('0 of 3 done')

  await epic.getByRole('button', { name: 'Collapse #200' }).click()
  await expect(epic).toHaveAttribute('data-collapsed', 'true')
  await expect(panel).toBeVisible()

  await epic.getByRole('button', { name: 'Hide info for #200' }).click()
  await expect(panel).toHaveCount(0)
  await expect(epic).toHaveAttribute('data-collapsed', 'true')
})

test('shows a failed detail read with a Retry action', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#204' })
  await row.getByRole('button', { name: 'Show details for #204' }).click()

  const panel = page.getByRole('region', { name: 'Details for #204' })
  await expect(panel.getByRole('alert')).toContainText('Resource not accessible')
  await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible()

  await row.getByRole('button', { name: 'Hide details for #204' }).click()
  await expect(panel).toHaveCount(0)
})

// Flow: clicking a Backlog ticket or epic opens a detail sidebar, fetched once on first open.
import { expect, test } from '@playwright/test'
import { assertNoDisallowedCalls, launchE2EApp } from './harness/app.mjs'
import type { E2EApp } from './harness/app.mjs'
import { sandboxState } from './fake/state.mjs'

let harness: E2EApp

const issue = (number: number) => ({
  number,
  title: `Ticket ${String(number)}`,
  url: `https://github.com/acme/widgets/issues/${String(number)}`,
  state: 'OPEN',
})

test.beforeEach(async () => {
  harness = await launchE2EApp({
    state: sandboxState({
      viewer: 'octocat',
      repo: 'acme/widgets',
      issues: [
        { number: 200, title: 'Ship the thing', labels: [], body: 'Epic body', author: 'octocat' },
        {
          number: 201,
          title: 'First step',
          labels: [],
          parent: 200,
          body: '**First** step',
          author: 'alice',
          assignees: ['bob'],
        },
        { number: 203, title: 'Third step', labels: [], parent: 200, blockedBy: [issue(201)] },
        {
          number: 204,
          title: 'Fourth step',
          labels: [],
          parent: 200,
          detailError: 'Resource not accessible',
        },
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

test('opens, switches and serves a reopened row from the cache', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const first = page.locator('[data-slot="backlog-row"]', { hasText: '#201' })
  await expect(first).toBeVisible()
  expect(await detailReads(201)).toBe(0)

  await first.getByText('First step').click()
  const pane = page.getByRole('complementary', { name: 'Details for #201' })
  await expect(pane.locator('strong')).toHaveText('First')
  await expect(pane.locator('[data-field="author"]')).toContainText('alice')
  await expect(pane.locator('[data-field="assignee"]')).toContainText('bob')
  await expect(pane.locator('[data-field="blocks"]').getByRole('link', { name: '#203' })).toBeVisible()
  expect(await detailReads(201)).toBe(1)

  await page.locator('[data-slot="backlog-row"]', { hasText: '#203' }).getByText('Third step').click()
  const second = page.getByRole('complementary', { name: 'Details for #203' })
  await expect(second.locator('[data-field="blocked-by"]')).toContainText('#201')
  await expect(pane).toHaveCount(0)

  await first.getByText('First step').click()
  await expect(pane.locator('strong')).toHaveText('First')
  expect(await detailReads(201)).toBe(1)
})

test('the title is not a link and the sidebar opens the ticket on GitHub', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#201' })
  await expect(row.getByRole('link')).toHaveCount(0)

  await row.getByText('First step').click()
  const pane = page.getByRole('complementary', { name: 'Details for #201' })
  await expect(pane.getByRole('link', { name: 'Open ticket' })).toHaveAttribute('href', /\/issues\/201$/)
})

test('Space opens the focused row, J does not move the pane and Escape closes it', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#203' })
  await row.focus()
  await page.keyboard.press('Space')

  const pane = page.getByRole('complementary', { name: 'Details for #203' })
  await expect(pane.locator('[data-field="blocked-by"]')).toContainText('#201')

  await page.keyboard.press('j')
  await expect(pane).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(pane).toHaveCount(0)
})

test('closes on a press on blank space or on the shown row', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#201' })
  const pane = page.getByRole('complementary', { name: 'Details for #201' })

  await row.getByText('First step').click()
  await expect(pane).toBeVisible()
  await page.locator('div.h-11 > span', { hasText: 'Backlog' }).click()
  await expect(pane).toHaveCount(0)
  await expect(page.locator('[data-slot="backlog-row"].bg-selection')).toHaveCount(0)

  await row.getByText('First step').click()
  await expect(pane).toBeVisible()
  await row.getByText('First step').click()
  await expect(pane).toHaveCount(0)
})

test('the epic opens in the sidebar and its chevron only collapses', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const epic = page.locator('[data-slot="backlog-epic"][data-epic="200"]')

  await epic.locator('[data-slot="backlog-epic-row"]').getByText('Ship the thing').click()
  const pane = page.getByRole('complementary', { name: 'Details for #200' })
  await expect(pane).toContainText('Epic body')
  await expect(pane).toContainText('0 of 3 done')
  await expect(pane.locator('[data-field="in-progress"]')).toBeVisible()
  await expect(pane.locator('[data-field="can-start"]')).toBeVisible()

  await epic.getByRole('button', { name: 'Collapse #200' }).click()
  await expect(epic).toHaveAttribute('data-collapsed', 'true')
  await expect(pane).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(pane).toHaveCount(0)
  await epic.getByRole('button', { name: 'Expand #200' }).click()
  await expect(epic).toHaveAttribute('data-collapsed', 'false')
  await expect(pane).toHaveCount(0)
})

test('shows a failed detail read with a Retry action', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#204' })
  await row.getByText('Fourth step').click()

  const pane = page.getByRole('complementary', { name: 'Details for #204' })
  await expect(pane.getByRole('alert')).toContainText('Resource not accessible')
  await expect(pane.getByRole('button', { name: 'Retry' })).toBeVisible()
})

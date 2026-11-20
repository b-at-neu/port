// Flow: a child epic nests inside its parent's dropdown, wave numbers run on through it, and keyboard navigation follows the visual order.
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
        { number: 400, title: 'Outer epic', labels: [], createdAt: '2024-02-01T00:00:00Z' },
        { number: 401, title: 'First step', labels: [], parent: 400 },
        { number: 410, title: 'Nested epic', labels: [], parent: 400, blockedBy: [issue(401)] },
        { number: 411, title: 'Nested first', labels: [], parent: 410 },
        { number: 412, title: 'Nested second', labels: [], parent: 410, blockedBy: [issue(411)] },
        { number: 402, title: 'After the nested epic', labels: [], parent: 400, blockedBy: [issue(410)] },
        { number: 420, title: 'Loose ticket', labels: [], createdAt: '2024-01-01T00:00:00Z' },
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

async function visualOrder(page: E2EApp['page']): Promise<(string | undefined)[]> {
  const texts = await page.locator('[data-slot="backlog-epic-row"], [data-slot="backlog-row"]').allTextContents()
  return texts.map((text) => /#(\d+)/.exec(text)?.[1])
}

test('nests the child epic inside its parent and numbers waves through it', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const outer = page.locator('[data-slot="backlog-epic"][data-epic="400"]')
  const nested = page.locator('[data-slot="backlog-epic"][data-epic="410"]')
  await expect(page.locator('[data-slot="backlog-epic"][data-epic="410"]')).toHaveCount(1)
  await expect(outer.locator('[data-slot="backlog-epic"][data-epic="410"]')).toHaveCount(1)
  await expect(nested).toHaveAttribute('data-nested', 'true')

  await expect(outer.locator('[data-slot="backlog-wave"][data-wave="1"]')).toContainText('#401')
  await expect(nested.locator('[data-slot="backlog-wave"][data-wave="2"]')).toContainText('#411')
  await expect(nested.locator('[data-slot="backlog-wave"][data-wave="3"]')).toContainText('#412')
  await expect(outer.locator('[data-slot="backlog-wave"][data-wave="4"]')).toContainText('#402')
  await expect(outer.locator('[data-slot="backlog-epic-row"]').first().getByRole('progressbar')).toContainText('0/3')
  await expect(page.locator('[data-slot="backlog-wave-band"]')).toHaveCount(0)
})

test('walks the nested epic in visual order with J', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  await expect(page.locator('[data-slot="backlog-epic"][data-epic="410"]')).toBeVisible()

  const expected = ['400', '401', '410', '411', '412', '402', '420']
  expect(await visualOrder(page)).toEqual(expected)
  for (const number of expected) {
    await page.keyboard.press('j')
    expect(await selectedNumber(page)).toMatch(new RegExp(`:${number}$`))
  }
})

test('collapsing the nested epic hides its tickets, and collapsing the parent hides it', async () => {
  const { page } = harness
  await page.getByRole('link', { name: 'Backlog', exact: true }).click()
  const nested = page.locator('[data-slot="backlog-epic"][data-epic="410"]')

  await nested.getByRole('button', { name: 'Collapse #410' }).click()
  await expect(page.locator('[data-slot="backlog-row"]', { hasText: '#411' })).toHaveCount(0)
  await expect(page.locator('[data-slot="backlog-row"]', { hasText: '#412' })).toHaveCount(0)
  await expect(page.locator('[data-slot="backlog-row"]', { hasText: '#402' })).toBeVisible()

  expect(await selectedNumber(page)).toMatch(/:410$/)
  await page.keyboard.press('j')
  expect(await selectedNumber(page)).toMatch(/:402$/)

  const outer = page.locator('[data-slot="backlog-epic"][data-epic="400"]')
  await outer.getByRole('button', { name: 'Collapse #400' }).click()
  await expect(page.locator('[data-slot="backlog-epic"][data-epic="410"]')).toHaveCount(0)
  expect(await visualOrder(page)).toEqual(['400', '420'])
})

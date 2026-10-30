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
      issues: [
        { number: 101, title: 'Fix the thing', labels: [] },
        { number: 102, title: 'Tidy the other thing', labels: [], assignees: ['alice'] },
        { number: 103, title: 'Ship the follow-up', labels: [], blockedBy: [{ number: 101, title: 'Fix the thing', url: 'https://github.com/acme/widgets/issues/101', state: 'OPEN' }] },
      ],
    }),
  })
})

test.afterEach(async ({}) => {
  assertNoDisallowedCalls(await harness.calls())
  await harness.close()
})

function editCallsFor(calls: Awaited<ReturnType<E2EApp['calls']>>, number: string) {
  return calls.filter((call) => call.command === 'gh' && call.args[0] === 'issue' && call.args[1] === 'edit' && call.args[2] === number)
}

test('claims an unlabelled backlog issue with a toast and no dialog, and the first row starts unhighlighted', async () => {
  const { page } = harness

  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#101' })
  await row.waitFor({ state: 'visible' })

  // The regression: before any keyboard input, nothing in the list is focus-highlighted.
  await expect(row).not.toHaveClass(/ring-2/)

  await row.getByRole('button', { name: 'Work on' }).click()
  await page.getByRole('menuitem', { name: 'Review the plan' }).click()

  await expect(page.locator('[data-sonner-toast]')).toContainText('#101 claimed')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-slot="backlog-row"]', { hasText: '#101' })).toHaveCount(0)

  const calls = await harness.calls()
  const editCalls = editCallsFor(calls, '101')
  expect(editCalls).toHaveLength(1)
  expect(editCalls[0]?.args).toContain('--add-label')

  const state = await harness.state()
  const issue = state.issues.find((i) => i.number === 101)
  expect(issue?.labels).toContain('ready')
  expect(issue?.labels).toContain('claude')
})

test('takes over an issue assigned to someone else only after one explicit click', async () => {
  const { page } = harness

  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#102' })
  await row.waitFor({ state: 'visible' })
  await row.getByRole('button', { name: 'Work on' }).click()
  await page.getByRole('menuitem', { name: 'Auto-approve the plan' }).click()

  const toast = page.locator('[data-sonner-toast]')
  await expect(toast).toContainText('#102 is assigned to @alice.')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(editCallsFor(await harness.calls(), '102')).toHaveLength(0)

  await toast.getByRole('button', { name: 'Take over' }).click()
  await expect(page.locator('[data-slot="backlog-row"]', { hasText: '#102' })).toHaveCount(0)

  const editCalls = editCallsFor(await harness.calls(), '102')
  expect(editCalls).toHaveLength(1)
  expect(editCalls[0]?.args).toContain('--remove-assignee')

  const state = await harness.state()
  const issue = state.issues.find((i) => i.number === 102)
  expect(issue?.labels).toEqual(expect.arrayContaining(['claude', 'ready', 'auto plan']))
  expect(issue?.assignees).toEqual(['octocat'])
})

test('asks before claiming a blocked issue, and claims only after Start anyway', async () => {
  const { page } = harness

  await page.getByRole('link', { name: 'Backlog', exact: true }).click()

  const row = page.locator('[data-slot="backlog-row"]', { hasText: '#103' })
  await row.waitFor({ state: 'visible' })
  await expect(row.locator('[data-slot="backlog-blocked"]')).toContainText('Blocked')

  await row.getByRole('button', { name: 'Work on' }).click()
  await page.getByRole('menuitem', { name: 'Review the plan' }).click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Start #103 anyway?')
  await expect(dialog).toContainText("It's blocked by 1 open ticket:")
  await expect(dialog.getByRole('link', { name: '#101 Fix the thing' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(editCallsFor(await harness.calls(), '103')).toHaveLength(0)

  await row.getByRole('button', { name: 'Work on' }).click()
  await page.getByRole('menuitem', { name: 'Review the plan' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start anyway' }).click()

  await expect(page.locator('[data-sonner-toast]')).toContainText('#103 claimed')
  expect(editCallsFor(await harness.calls(), '103')).toHaveLength(1)
})

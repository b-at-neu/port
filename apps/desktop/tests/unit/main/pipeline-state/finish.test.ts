import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finishPipelineState, retryMirrors } from '@/main/pipeline/state/finish'
import { readAuditLog } from '@/main/github/writes/audit'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { createTestContext } from '../../../support/context'
import { createFakeGitHub, type FakeItem } from '../../../support/fake-github'
import { readyEntry } from '../../../support/repo-config'
import { AT } from '../../../support/state-store'
import { ticketOf } from '../../../support/tickets'

const REPO = 'repo-a' as RepoId
const ENTRY = readyEntry({ id: REPO })
const FAILURE = { at: AT, outcome: { kind: 'item-unavailable' as const } }

const withPr = (ticket: number, pr: number, overrides: Partial<Ticket> = {}): Ticket => ticketOf({ repo: REPO, ticket, pr: { number: pr, approvedAt: null }, stage: 'merge', status: { kind: 'waiting-on-you', gate: 'merge', detail: '' }, ...overrides })
const failed = (ticket: number, pr: number | null): Ticket => ticketOf({ repo: REPO, ticket, pr: pr === null ? null : { number: pr, approvedAt: null }, mirror: { written: [], failure: FAILURE } })

const issueItem = (number: number): FakeItem => ({ number, labels: ['port'], assignees: ['op'] })
const prItem = (number: number, issue: number): FakeItem => ({ number, kind: 'pull-request', labels: ['port'], assignees: ['op'], headRefName: `${String(issue)}-fix` })

async function rig(tickets: readonly Ticket[] | null, items: readonly FakeItem[]) {
  const github = createFakeGitHub({ items })
  const ctx = createTestContext({ platform: github.platform, ...(tickets === null ? {} : { tickets: { repoId: REPO, tickets } }) })
  await ctx.ready
  const auditDir = await mkdtemp(join(tmpdir(), 'port-finish-'))
  const retried = new Map<string, number>()
  const retries = async () => {
    const read = await readAuditLog(auditDir)
    return read.ok ? read.entries.filter((entry) => entry.action === 'mirror-retry').map((entry) => entry.number) : []
  }
  return {
    ctx,
    github,
    retried,
    retries,
    finish: (finished: { closed: number[]; merged: number[] }) => finishPipelineState(ctx, ENTRY, finished, auditDir),
    retry: () => retryMirrors(ctx, ENTRY, auditDir, retried),
    held: (number: number, kind: 'issue' | 'pull-request' = 'pull-request') => ctx.stores.pipelineState.ticket(REPO, { kind, number }),
  }
}

describe('finishPipelineState', () => {
  it('marks a merged pull request done and shows it on both halves, then prunes the closed items', async () => {
    const r = await rig([withPr(7, 9)], [issueItem(7), prItem(9, 7)])
    await r.finish({ closed: [7, 9], merged: [9] })
    expect(r.github.labels(7)).toContain('approved')
    expect(r.github.labels(9)).toContain('approved')
    expect(r.held(9)).toBeNull()
  })

  it('prunes a closed but unmerged item untouched', async () => {
    const r = await rig([withPr(7, 9)], [issueItem(7), prItem(9, 7)])
    await r.finish({ closed: [7, 9], merged: [] })
    expect(r.github.labels(9)).toEqual(['port'])
    expect(r.held(9)).toBeNull()
  })

  it.each([
    { name: 'a merged number the store does not hold', tickets: [withPr(7, 9)] },
    { name: 'an unseeded repository', tickets: null },
  ])('writes nothing for $name', async ({ tickets }) => {
    const r = await rig(tickets, [issueItem(7), prItem(9, 7)])
    await r.finish({ closed: [12], merged: [12] })
    expect(r.github.labels(9)).toEqual(['port'])
  })
})

describe('retryMirrors', () => {
  it('re-mirrors only the tickets carrying a failure, through the pull request when there is one', async () => {
    const r = await rig([ticketOf({ repo: REPO, ticket: 1 }), failed(2, null), failed(3, 30)], [issueItem(1), issueItem(2), issueItem(3), prItem(30, 3)])
    await r.retry()
    expect(r.held(2, 'issue')?.mirror.failure).toBeNull()
    expect(r.held(30)?.mirror.failure).toBeNull()
    expect(r.github.labels(1)).toEqual(['port'])
    expect(await r.retries()).toEqual(expect.arrayContaining([2, 30]))
  })

  it('retries at most ten tickets a poll', async () => {
    const tickets = Array.from({ length: 14 }, (_, index) => failed(index + 1, null))
    const r = await rig(tickets, tickets.map((ticket) => issueItem(ticket.ticket)))
    await r.retry()
    expect(tickets.filter((ticket) => r.held(ticket.ticket, 'issue')?.mirror.failure === null)).toHaveLength(10)
  })

  it('does nothing for an unseeded repository', async () => {
    const r = await rig(null, [issueItem(2)])
    await r.retry()
    expect(await r.retries()).toEqual([])
  })

  it.each([
    { name: 'inside the window', elapsedMs: [60_000], retries: 1 },
    { name: 'after the window', elapsedMs: [60_000, 5 * 60_000], retries: 2 },
  ])('retries a persisting failure once per backoff window — $name', async ({ elapsedMs, retries }) => {
    const r = await rig([failed(2, null)], [issueItem(2)])
    r.github.failWrites(2, 'offline')
    await r.retry()
    for (const ms of elapsedMs) {
      r.ctx.clock.advance(ms)
      await r.retry()
    }
    expect(await r.retries()).toHaveLength(retries)
  })
})

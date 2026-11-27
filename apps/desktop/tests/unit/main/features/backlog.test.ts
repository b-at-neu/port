import { describe, expect, it, vi } from 'vitest'
import type { BacklogListParams } from '@/main/github/tracker'
import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import { readyEntry } from '../../../support/repo-config'
import { callAction, createTestContext } from '../../../support/context'
import { createFakeTracker } from '../../../support/fake-tracker'
import { ticketOf } from '../../../support/tickets'

const REPO_ID = readyEntry().id

describe('backlog actions', () => {
  it.each(['backlog.list', 'backlog.detail'] as const)('%s rejects a repository that is not registered', async (name) => {
    const ctx = createTestContext()
    await expect(callAction(ctx, name, { repoId: REPO_ID, number: 45 })).rejects.toThrow(`found no repository registered with id '${REPO_ID}'`)
  })

  it.each(['backlog.list', 'backlog.detail'] as const)('%s rejects a repository that is not ready', async (name) => {
    const ctx = createTestContext({ repositories: [{ id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' }, diagnostics: [] }] })
    await expect(callAction(ctx, name, { repoId: REPO_ID, number: 45 })).rejects.toThrow("requires a 'ready' repository, got 'directory-missing'")
  })

  it('surfaces a registry that could not be listed', async () => {
    const ctx = createTestContext({ repos: { list: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }) } })
    await expect(callAction(ctx, 'backlog.list', { repoId: REPO_ID })).rejects.toThrow("'backlog:list' could not list repositories: disk on fire")
  })

  it('list hands the tracker the issues the store already tracks and returns its reply', async () => {
    const reply: BacklogResponse = { ok: true, items: [], scanned: 0, total: 0, viewer: null, fetchedAt: 'x' }
    const listBacklog = vi.fn<(params: BacklogListParams) => Promise<BacklogResponse>>(() => Promise.resolve(reply))
    const ctx = createTestContext({
      tracker: createFakeTracker({ listBacklog }),
      repositories: [readyEntry()],
      tickets: { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 12 })] },
    })
    await ctx.ready
    expect(await callAction(ctx, 'backlog.list', { repoId: REPO_ID })).toBe(reply)
    expect(listBacklog).toHaveBeenCalledWith({ repo: { owner: 'o', name: 'a' }, tracked: new Set([12]) })
  })

  it('detail passes the tracker outcome through', async () => {
    const reply: BacklogDetailResponse = { ok: false, kind: 'issue-missing', message: 'gone', fetchedAt: 'x' }
    const ctx = createTestContext({ tracker: createFakeTracker({ readTicket: () => Promise.resolve(reply) }), repositories: [readyEntry()] })
    expect(await callAction(ctx, 'backlog.detail', { repoId: REPO_ID, number: 45 })).toBe(reply)
  })
})

import { describe, expect, it } from 'vitest'
import { readyEntry } from '../../../support/repo-config'
import { callAction, createTestContext } from '../../../support/context'
import { fakeTransport, httpOk } from '../../../fixtures/github-http'
import { ticketOf } from '../../../support/tickets'

const REPO_ID = readyEntry().id
const NO_BLOCKERS = { totalCount: 0, nodes: [] }
const node = (number: number) => ({ number, title: `t${String(number)}`, url: `u${String(number)}`, createdAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] }, blockedBy: NO_BLOCKERS, blocking: NO_BLOCKERS, parent: null })

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

  it('list omits the issues the store already tracks', async () => {
    const body = JSON.stringify({ data: { repository: { issues: { totalCount: 3, nodes: [node(12), node(13), node(40)] } }, viewer: { login: 'octo-dev' } } })
    const ctx = createTestContext({
      platform: { githubHttp: fakeTransport(httpOk(body)) },
      repositories: [readyEntry()],
      tickets: { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 12 })] },
    })
    await ctx.ready
    const result = await callAction(ctx, 'backlog.list', { repoId: REPO_ID })
    expect(result.ok && result.items.map((item) => item.number)).toEqual([13, 40])
  })

  it('detail passes a typed issue-missing outcome through', async () => {
    const ctx = createTestContext({ platform: { githubHttp: fakeTransport(httpOk(JSON.stringify({ data: { repository: { detail: null } } }))) }, repositories: [readyEntry()] })
    expect(await callAction(ctx, 'backlog.detail', { repoId: REPO_ID, number: 45 })).toMatchObject({ ok: false, kind: 'issue-missing' })
  })
})

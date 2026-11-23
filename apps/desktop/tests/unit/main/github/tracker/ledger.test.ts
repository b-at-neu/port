import { describe, expect, it } from 'vitest'
import { readLedger } from '@/main/github/tracker/ledger'
import { renderLedger } from '@/main/dispatch/budget-ledger'
import type { LedgerRow } from '@/types/budget'
import type { GitHubHttpResult, GitHubRequest } from '@/types/platform'

const ROW: LedgerRow = { stage: 'impl', model: 'sonnet', startedAt: '2026-09-05T14:00:00.000Z', seconds: 120, outcome: 'completed' }
const PARAMS = { owner: 'acme', name: 'widgets', issue: 52 }

const okHttp = (body: string): GitHubHttpResult => ({ ok: true, status: 200, headers: {}, body })

function envelope(nodes: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ data: { viewer: { login: 'me' }, repository: { issue: { comments: { nodes } } } }, ...extra })
}

function comment(body: string, login = 'me', databaseId = 9): unknown {
  return { databaseId, body, author: { login } }
}

function read(respond: (request: GitHubRequest) => GitHubHttpResult) {
  const requests: GitHubRequest[] = []
  const github = (request: GitHubRequest): Promise<GitHubHttpResult> => {
    requests.push(request)
    return Promise.resolve(respond(request))
  }
  return { read: () => readLedger({ ...PARAMS, github }), requests }
}

describe('readLedger', () => {
  it('reads the viewer-authored ledger comment with one GraphQL request', async () => {
    const { read: r, requests } = read(() => okHttp(envelope([comment(renderLedger([ROW], null))])))
    expect(await r()).toEqual({ ok: true, rows: [ROW], seconds: 120, ref: 9 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', path: 'graphql' })
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ variables: { owner: 'acme', name: 'widgets' } })
  })

  it('reads an envelope from a classified failure too', async () => {
    const { read: r } = read(() => ({ ok: false, kind: 'unknown', status: 200, body: envelope([comment(renderLedger([ROW], null))]), message: 'partial' }))
    expect(await r()).toMatchObject({ ok: true, seconds: 120 })
  })

  it('treats no ledger comment as an empty ledger', async () => {
    const { read: r } = read(() => okHttp(envelope([comment('hello')])))
    expect(await r()).toEqual({ ok: true, rows: [], seconds: 0, ref: null })
  })

  it('ignores a look-alike ledger written by another account', async () => {
    const { read: r } = read(() => okHttp(envelope([comment(renderLedger([ROW], null), 'someone-else')])))
    expect(await r()).toMatchObject({ ok: true, rows: [] })
  })

  it('is unreadable when errors[].path names comments', async () => {
    const { read: r } = read(() => okHttp(envelope([], { errors: [{ path: ['comments'], message: 'x' }] })))
    const result = await r()
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toContain("'comments' unavailable")
  })

  it('is unreadable without a viewer login', async () => {
    const { read: r } = read(() => okHttp(JSON.stringify({ data: { viewer: null, repository: { issue: { comments: { nodes: [] } } } } })))
    expect(await r()).toMatchObject({ ok: false })
  })

  it('is unreadable when the comment list is absent', async () => {
    const { read: r } = read(() => okHttp(JSON.stringify({ data: { viewer: { login: 'me' }, repository: null } })))
    expect(await r()).toMatchObject({ ok: false })
  })

  it('is unreadable when the ledger body does not parse', async () => {
    const { read: r } = read(() => okHttp(envelope([comment('## Pipeline Cost\n\nno table')])))
    const result = await r()
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toContain("doesn't parse")
  })

  it('names the transport failure when there is no envelope', async () => {
    const { read: r } = read(() => ({ ok: false, kind: 'network', status: null, body: '', message: 'no route' }))
    const result = await r()
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toBe('no route')
  })
})

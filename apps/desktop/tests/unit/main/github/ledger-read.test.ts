import { describe, expect, it } from 'vitest'
import { createLedgerReader } from '@/main/github/ledger-read'
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

function reader(respond: (request: GitHubRequest) => GitHubHttpResult) {
  const requests: GitHubRequest[] = []
  const github = (request: GitHubRequest): Promise<GitHubHttpResult> => {
    requests.push(request)
    return Promise.resolve(respond(request))
  }
  return { reader: createLedgerReader({ github }), requests }
}

describe('readLedger', () => {
  it('reads the viewer-authored ledger comment with one GraphQL request', async () => {
    const { reader: r, requests } = reader(() => okHttp(envelope([comment(renderLedger([ROW], null))])))
    expect(await r.readLedger(PARAMS)).toEqual({ ok: true, rows: [ROW], seconds: 120, ref: 9 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', path: 'graphql' })
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ variables: { owner: 'acme', name: 'widgets' } })
  })

  it('reads an envelope from a classified failure too', async () => {
    const { reader: r } = reader(() => ({ ok: false, kind: 'unknown', status: 200, body: envelope([comment(renderLedger([ROW], null))]), message: 'partial' }))
    expect(await r.readLedger(PARAMS)).toMatchObject({ ok: true, seconds: 120 })
  })

  it('treats no ledger comment as an empty ledger', async () => {
    const { reader: r } = reader(() => okHttp(envelope([comment('hello')])))
    expect(await r.readLedger(PARAMS)).toEqual({ ok: true, rows: [], seconds: 0, ref: null })
  })

  it('ignores a look-alike ledger written by another account', async () => {
    const { reader: r } = reader(() => okHttp(envelope([comment(renderLedger([ROW], null), 'someone-else')])))
    expect(await r.readLedger(PARAMS)).toMatchObject({ ok: true, rows: [] })
  })

  it('is unreadable when errors[].path names comments', async () => {
    const { reader: r } = reader(() => okHttp(envelope([], { errors: [{ path: ['comments'], message: 'x' }] })))
    const result = await r.readLedger(PARAMS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toContain("'comments' unavailable")
  })

  it('is unreadable without a viewer login', async () => {
    const { reader: r } = reader(() => okHttp(JSON.stringify({ data: { viewer: null, repository: { issue: { comments: { nodes: [] } } } } })))
    expect(await r.readLedger(PARAMS)).toMatchObject({ ok: false })
  })

  it('is unreadable when the comment list is absent', async () => {
    const { reader: r } = reader(() => okHttp(JSON.stringify({ data: { viewer: { login: 'me' }, repository: null } })))
    expect(await r.readLedger(PARAMS)).toMatchObject({ ok: false })
  })

  it('is unreadable when the ledger body does not parse', async () => {
    const { reader: r } = reader(() => okHttp(envelope([comment('## Pipeline Cost\n\nno table')])))
    const result = await r.readLedger(PARAMS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toContain("doesn't parse")
  })

  it('names the transport failure when there is no envelope', async () => {
    const { reader: r } = reader(() => ({ ok: false, kind: 'network', status: null, body: '', message: 'no route' }))
    const result = await r.readLedger(PARAMS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toBe('no route')
  })
})

describe('issueForPr', () => {
  it('resolves the issue from the pull request body', async () => {
    const { reader: r, requests } = reader(() => okHttp(JSON.stringify({ body: 'Closes #52\n\ntext' })))
    expect(await r.issueForPr({ repo: 'acme/widgets', pr: 213 })).toEqual({ ok: true, issue: 52 })
    expect(requests[0]).toMatchObject({ method: 'GET', path: 'repos/acme/widgets/pulls/213' })
  })

  it('names a missing Closes line', async () => {
    const { reader: r } = reader(() => okHttp(JSON.stringify({ body: 'no link' })))
    expect(await r.issueForPr({ repo: 'acme/widgets', pr: 213 })).toEqual({ ok: false, why: "PR #213's body has no 'Closes #N' on its first line — cannot resolve its ticket." })
  })

  it('reports a transport failure', async () => {
    const { reader: r } = reader(() => ({ ok: false, kind: 'http-not-found', status: 404, body: '', message: 'not found' }))
    expect(await r.issueForPr({ repo: 'acme/widgets', pr: 213 })).toEqual({ ok: false, why: "could not read PR #213's body: not found" })
  })
})

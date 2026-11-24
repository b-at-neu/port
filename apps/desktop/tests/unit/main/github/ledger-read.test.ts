import { describe, expect, it } from 'vitest'
import { issueForPr, readLedger } from '@/main/github/ledger-read'
import { renderLedger } from '@/main/github/budget-ledger'
import type { LedgerRow } from '@/types/budget'
import type { GitHubHttpResult } from '@/types/platform'
import { githubCtx, httpOk, recordingTransport } from '../../../fixtures/github-http'

const ROW: LedgerRow = { stage: 'impl', model: 'sonnet', startedAt: '2026-09-05T14:00:00.000Z', seconds: 120, outcome: 'completed' }
const PARAMS = { owner: 'acme', name: 'widgets', issue: 52 }
const LEDGER = renderLedger([ROW], null)

function envelope(nodes: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ data: { viewer: { login: 'me' }, repository: { issue: { comments: { nodes } } } }, ...extra })
}

function comment(body: string, login = 'me', databaseId = 9): unknown {
  return { databaseId, body, author: { login } }
}

function ctxReplying(reply: GitHubHttpResult | string) {
  const { transport, requests } = recordingTransport(() => reply)
  return { ctx: githubCtx(transport), requests }
}

describe('readLedger', () => {
  it('reads the viewer-authored ledger comment with one GraphQL request', async () => {
    const { ctx, requests } = ctxReplying(envelope([comment(LEDGER)]))
    expect(await readLedger(ctx, PARAMS)).toEqual({ ok: true, rows: [ROW], seconds: 120, ref: 9 })
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ variables: { owner: 'acme', name: 'widgets' } })
  })

  const outcomes: readonly { readonly name: string; readonly reply: GitHubHttpResult | string; readonly expected: object }[] = [
    { name: 'an envelope from a classified failure is still read', reply: { ok: false, kind: 'unknown', status: 200, body: envelope([comment(LEDGER)]), message: 'partial' }, expected: { ok: true, seconds: 120 } },
    { name: 'no ledger comment is an empty ledger', reply: envelope([comment('hello')]), expected: { ok: true, rows: [], seconds: 0, ref: null } },
    { name: 'a look-alike written by another account is ignored', reply: envelope([comment(LEDGER, 'someone-else')]), expected: { ok: true, rows: [] } },
    { name: 'errors naming comments make it unreadable', reply: envelope([], { errors: [{ path: ['comments'], message: 'x' }] }), expected: { ok: false, why: "GitHub reported 'comments' unavailable while reading #52's ledger" } },
    { name: 'no viewer login makes it unreadable', reply: JSON.stringify({ data: { viewer: null, repository: { issue: { comments: { nodes: [] } } } } }), expected: { ok: false } },
    { name: 'an absent comment list makes it unreadable', reply: JSON.stringify({ data: { viewer: { login: 'me' }, repository: null } }), expected: { ok: false } },
    { name: 'a body that does not parse makes it unreadable', reply: envelope([comment('## Pipeline Cost\n\nno table')]), expected: { ok: false, why: "its comment doesn't parse as a '## Pipeline Cost' table" } },
    { name: 'a transport failure with no envelope is named', reply: { ok: false, kind: 'network', status: null, body: '', message: 'no route' }, expected: { ok: false, why: 'no route' } },
  ]
  it.each(outcomes)('$name', async ({ reply, expected }) => {
    expect(await readLedger(ctxReplying(reply).ctx, PARAMS)).toMatchObject(expected)
  })
})

describe('issueForPr', () => {
  const cases: readonly { readonly name: string; readonly reply: GitHubHttpResult | string; readonly expected: object }[] = [
    { name: 'resolves the issue from the pull request body', reply: JSON.stringify({ body: 'Closes #52\n\ntext' }), expected: { ok: true, issue: 52 } },
    { name: 'names a missing Closes line', reply: JSON.stringify({ body: 'no link' }), expected: { ok: false, why: "PR #213's body has no 'Closes #N' on its first line — cannot resolve its ticket." } },
    { name: 'reports a transport failure', reply: { ok: false, kind: 'http-not-found', status: 404, body: '', message: 'not found' }, expected: { ok: false, why: "could not read PR #213's body: not found" } },
    { name: 'reports a body that is not JSON', reply: httpOk('nope'), expected: { ok: false, why: "could not read PR #213's body: GitHub's reply wasn't JSON" } },
  ]
  it.each(cases)('$name', async ({ reply, expected }) => {
    const { ctx, requests } = ctxReplying(reply)
    expect(await issueForPr(ctx, { repo: 'acme/widgets', pr: 213 })).toEqual(expected)
    expect(requests[0]).toMatchObject({ method: 'GET', path: 'repos/acme/widgets/pulls/213' })
  })
})

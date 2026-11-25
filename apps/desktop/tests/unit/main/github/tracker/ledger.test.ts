import { describe, expect, it } from 'vitest'
import { readLedger } from '@/main/github/tracker/ledger'
import { renderLedger } from '@/main/github/budget-ledger'
import type { LedgerRow } from '@/types/budget'
import type { GitHubHttpResult } from '@/types/platform'
import { githubCtx, recordingTransport } from '../../../../fixtures/github-http'

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

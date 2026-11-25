import { describe, expect, it } from 'vitest'
import { issueForPr } from '@/main/github/ledger-read'
import type { GitHubHttpResult } from '@/types/platform'
import { githubCtx, httpOk, recordingTransport } from '../../../fixtures/github-http'

describe('issueForPr', () => {
  const cases: readonly { readonly name: string; readonly reply: GitHubHttpResult | string; readonly expected: object }[] = [
    { name: 'resolves the issue from the pull request body', reply: JSON.stringify({ body: 'Closes #52\n\ntext' }), expected: { ok: true, issue: 52 } },
    { name: 'names a missing Closes line', reply: JSON.stringify({ body: 'no link' }), expected: { ok: false, why: "PR #213's body has no 'Closes #N' on its first line — cannot resolve its ticket." } },
    { name: 'reports a transport failure', reply: { ok: false, kind: 'http-not-found', status: 404, body: '', message: 'not found' }, expected: { ok: false, why: "could not read PR #213's body: not found" } },
    { name: 'reports a body that is not JSON', reply: httpOk('nope'), expected: { ok: false, why: "could not read PR #213's body: GitHub's reply wasn't JSON" } },
  ]
  it.each(cases)('$name', async ({ reply, expected }) => {
    const { transport, requests } = recordingTransport(() => reply)
    expect(await issueForPr(githubCtx(transport), { repo: 'acme/widgets', pr: 213 })).toEqual(expected)
    expect(requests[0]).toMatchObject({ method: 'GET', path: 'repos/acme/widgets/pulls/213' })
  })
})

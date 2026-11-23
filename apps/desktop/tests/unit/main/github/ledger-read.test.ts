import { describe, expect, it } from 'vitest'
import { createPullRequestBodyReader } from '@/main/github/ledger-read'
import type { GitHubHttpResult, GitHubRequest } from '@/types/platform'

const okHttp = (body: string): GitHubHttpResult => ({ ok: true, status: 200, headers: {}, body })

function reader(respond: (request: GitHubRequest) => GitHubHttpResult) {
  const requests: GitHubRequest[] = []
  const github = (request: GitHubRequest): Promise<GitHubHttpResult> => {
    requests.push(request)
    return Promise.resolve(respond(request))
  }
  return { reader: createPullRequestBodyReader({ github }), requests }
}

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

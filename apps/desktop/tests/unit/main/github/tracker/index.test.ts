import { describe, expect, it } from 'vitest'
import { createGithubTracker } from '@/main/github/tracker'
import type { RepoId } from '@/utils/repos'
import { scriptedConditional } from '../../../../fixtures/watcher-harness'
import { fakeTransport, httpOk, queryOf } from '../../../../fixtures/github-http'

const REPO_ID = 'repo-1' as RepoId
const REPO = { owner: 'o', name: 'r' }

describe('createGithubTracker', () => {
  it('binds its transport into the point reads, so no call carries one', async () => {
    const seen: string[] = []
    const tracker = createGithubTracker({
      github: (request) => {
        seen.push(queryOf(request))
        return Promise.resolve(httpOk(JSON.stringify({ data: { repository: { n0: { __typename: 'Issue', number: 4, title: 't', url: 'u', state: 'OPEN' } } } })))
      },
    })
    const result = await tracker.readItemsByNumber({ repo: REPO, numbers: [4] })
    expect(result.ok && result.resolved.map((entry) => entry.number)).toEqual([4])
    expect(seen).toHaveLength(1)
  })

  it('reads item states through the same transport', async () => {
    const tracker = createGithubTracker({ github: fakeTransport(httpOk(JSON.stringify({ data: { repository: { n4: { __typename: 'Issue', state: 'CLOSED' } } } }))) })
    const result = await tracker.readItemStates({ repo: REPO, numbers: [4] })
    expect(result.ok && result.states.get(4)).toBe('CLOSED')
  })

  it('owns the ETag cache behind precheck: the first answer primes it, a changed ETag reports a change, and forget re-primes', async () => {
    const issues = scriptedConditional()
    const tracker = createGithubTracker({ conditional: issues.transport })
    expect(await tracker.precheck({ repoId: REPO_ID, repo: REPO })).toMatchObject({ ok: true, changed: false })
    expect(await tracker.precheck({ repoId: REPO_ID, repo: REPO })).toMatchObject({ ok: true, changed: false })
    issues.bump()
    expect(await tracker.precheck({ repoId: REPO_ID, repo: REPO })).toMatchObject({ ok: true, changed: true })
    issues.bump()
    tracker.forget(REPO_ID)
    expect(await tracker.precheck({ repoId: REPO_ID, repo: REPO })).toMatchObject({ ok: true, changed: false })
  })
})

import { describe, expect, it } from 'vitest'
import type { GitHubHttpResult, GitHubRequest, GitHubTransport } from '@/types/platform'
import type { ReleaseConfig } from '@/types/release'
import { fetchReleaseStatus } from '@/main/github/release'
import { buildStateQuery, stateVariables } from '@/main/github/release-query'
import { graphqlBodyOf, httpFail, httpOk } from '../../../fixtures/github-http'

const CONFIG: ReleaseConfig = { versionSource: 'package', versionFiles: ['package.json'], versionCommand: null, postPublishHook: null }
const REPO = { owner: 'acme', name: 'widgets' }
const NOW = () => new Date('2026-09-05T14:00:00.000Z')

function ok(body: string): GitHubHttpResult {
  return httpOk(body)
}

// A merged-PR node as GitHub returns it; `updatedAt` is never before `mergedAt`.
function pr(number: number, mergedAt: string, title = `#${String(number)} change ${String(number)}`): unknown {
  return { number, title, url: `u/${String(number)}`, mergedAt, updatedAt: mergedAt, author: { __typename: 'User' }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] } }
}

interface Scenario {
  readonly state?: Record<string, unknown>
  readonly errors?: readonly { path: readonly (string | number)[]; message: string }[]
  readonly prs?: readonly unknown[]
  readonly prsFail?: boolean
  readonly calls?: GitHubRequest[]
}

const STATE = {
  releases: { nodes: [{ tagName: 'v0.2.0', name: 'v0.2.0', url: 'u', publishedAt: '2026-08-01T00:00:00Z', isDraft: false, isPrerelease: false, isLatest: true, description: 'notes', tagCommit: { committedDate: '2026-07-30T00:00:00Z' } }] },
  openReleasePr: { nodes: [] },
  closedReleasePr: { nodes: [] },
  bumpRefs: { nodes: [] },
  integrationFile: { text: JSON.stringify({ version: '0.2.1-dev' }) },
  productionFile: { text: JSON.stringify({ version: '0.2.0' }) },
  integrationHead: { target: { oid: 'int-oid', tree: { oid: 'int-tree' } } },
  productionHead: { target: { oid: 'prod-oid', committedDate: '2026-08-20T00:00:00Z' } },
}

function runner(scenario: Scenario): GitHubTransport {
  return (request) => {
    scenario.calls?.push(request)
    const query = graphqlBodyOf(request).query
    if (query.includes('$base: String!')) {
      if (scenario.prsFail === true) return Promise.resolve(httpFail('network', 502, '', 'GitHub: HTTP 502'))
      return Promise.resolve(ok(JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: scenario.prs ?? [] } } } })))
    }
    return Promise.resolve(ok(JSON.stringify({ data: { repository: { ...STATE, ...scenario.state }, viewer: { login: 'octo-operator' } }, ...(scenario.errors === undefined ? {} : { errors: scenario.errors }) })))
  }
}

function prCalls(calls: readonly GitHubRequest[]): readonly GitHubRequest[] {
  return calls.filter((call) => graphqlBodyOf(call).query.includes('$base: String!'))
}

function fetchStatus(scenario: Scenario, overrides: Partial<Parameters<typeof fetchReleaseStatus>[0]> = {}) {
  return fetchReleaseStatus({ repo: REPO, integration: 'dev', production: 'main', moduleEnabled: true, config: CONFIG, github: runner(scenario), now: NOW, ...overrides })
}

describe('fetchReleaseStatus', () => {
  it('lists the PRs merged after the latest release tag commit, newest first, with its tag as sinceTag', async () => {
    const calls: GitHubRequest[] = []
    const result = await fetchStatus({ calls, prs: [pr(10, '2026-08-03T00:00:00Z'), pr(12, '2026-08-05T00:00:00Z'), pr(9, '2026-07-31T00:00:00Z')] })
    if (!result.ok) throw new Error(result.message)
    expect(result.status.phase).toEqual({ kind: 'idle' })
    expect(result.status.entries.map((e) => [e.number, e.title])).toEqual([
      [12, 'change 12'],
      [10, 'change 10'],
      [9, 'change 9'],
    ])
    expect(result.status.sinceTag).toBe('v0.2.0')
    expect(result.status.currentVersion).toBe('0.2.0')
    expect(result.status.productionHead).toBe('prod-oid')
    expect(result.integrationHead).toEqual({ oid: 'int-oid', tree: 'int-tree' })
    expect(prCalls(calls).map((call) => graphqlBodyOf(call).variables.base)).toEqual(['dev'])
    expect(result.status.releases).toHaveLength(1)
  })

  it('counts from the tag commit, so a PR merged between it and the publish stays in', async () => {
    const result = await fetchStatus({ prs: [pr(11, '2026-07-31T12:00:00Z'), pr(8, '2026-07-29T00:00:00Z')] })
    expect(result.ok && result.status.entries.map((e) => e.number)).toEqual([11])
  })

  it('falls back to publishedAt when the release has no tag commit', async () => {
    const release = { ...STATE.releases.nodes[0], tagCommit: null }
    const result = await fetchStatus({ state: { releases: { nodes: [release] } }, prs: [pr(11, '2026-07-31T12:00:00Z'), pr(12, '2026-08-02T00:00:00Z')] })
    expect(result.ok && result.status.entries.map((e) => e.number)).toEqual([12])
  })

  it('lists every merged PR when there is no release, with no sinceTag', async () => {
    const result = await fetchStatus({ state: { releases: { nodes: [] } }, prs: [pr(1, '2020-01-01T00:00:00Z')] })
    if (!result.ok) throw new Error(result.message)
    expect(result.status.entries.map((e) => e.number)).toEqual([1])
    expect(result.status.sinceTag).toBeNull()
  })

  it('is nothing-to-release when no PR merged since the tag', async () => {
    const result = await fetchStatus({ prs: [] })
    expect(result.ok && result.status.phase.kind).toBe('nothing-to-release')
  })

  it('fails the whole status when the first PR page cannot be read', async () => {
    const result = await fetchStatus({ prsFail: true })
    expect(result).toMatchObject({ ok: false, message: "Couldn't read the merged PRs: GitHub: HTTP 502" })
  })

  it('resolves the signed-in login, and a failed viewer read only drops it', async () => {
    const read = await fetchStatus({})
    expect(read.ok && read.viewer).toBe('octo-operator')
    const failed = await fetchStatus({ errors: [{ path: ['viewer'], message: 'boom' }] })
    expect(failed.ok && failed.viewer).toBeNull()
  })

  it('fails the whole status when any state alias is unavailable', async () => {
    const result = await fetchStatus({ errors: [{ path: ['repository', 'bumpRefs'], message: 'boom' }], state: { bumpRefs: null } })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.message).toContain('bumpRefs')
  })

  it('reads a version from the bump branch and reads no PRs while waiting on a merge', async () => {
    const calls: GitHubRequest[] = []
    const result = await fetchStatus({ calls, state: { openReleasePr: { nodes: [{ number: 612, url: 'pr', title: 'Release v0.3.0', state: 'OPEN', merged: false }] } } })
    expect(result.ok && result.status.phase).toMatchObject({ kind: 'waiting-merge', version: '0.3.0' })
    expect(prCalls(calls)).toHaveLength(0)
  })

  it('rebuilds a prefix-relative bump ref into its full branch name and sends the prefix', async () => {
    const calls: GitHubRequest[] = []
    const result = await fetchStatus({ calls, state: { bumpRefs: { nodes: [{ name: 'v0.3.0', associatedPullRequests: { nodes: [{ number: 611, url: 'u' }] } }] } } })
    expect(result.ok && result.status.phase).toMatchObject({ kind: 'waiting-bump', version: '0.3.0', bumpPr: { number: 611, url: 'u' } })
    expect(calls.some((call) => call.path === 'graphql' && graphqlBodyOf(call).variables.bumpRefPrefix === 'refs/heads/bump/')).toBe(true)
  })

  it('ignores a bump ref that is not a version branch', async () => {
    const result = await fetchStatus({ state: { bumpRefs: { nodes: [{ name: 'v0.3.0', associatedPullRequests: { nodes: [] } }, { name: 'cleanup', associatedPullRequests: { nodes: [] } }] } } })
    expect(result.ok && result.status.phase.kind).toBe('waiting-bump')
  })

  it('is a conflict when two version bump branches exist', async () => {
    const result = await fetchStatus({ state: { bumpRefs: { nodes: [{ name: 'v0.3.0', associatedPullRequests: { nodes: [] } }, { name: 'v0.4.0', associatedPullRequests: { nodes: [] } }] } } })
    expect(result.ok && result.status.phase).toEqual({ kind: 'conflict', branches: ['bump/v0.3.0', 'bump/v0.4.0'] })
  })

  it('bounds the release notes at the production head when ready to publish, and drops draft releases', async () => {
    const calls: GitHubRequest[] = []
    const state = {
      closedReleasePr: { nodes: [{ number: 612, url: 'pr', title: 'Release v0.3.0', state: 'MERGED', merged: true }] },
      releases: { nodes: [...STATE.releases.nodes, { tagName: 'v0.4.0', name: 'v0.4.0', url: 'u', publishedAt: null, isDraft: true, isPrerelease: false, isLatest: false, description: '' }] },
    }
    const result = await fetchStatus({ calls, state, prs: [pr(30, '2026-08-25T00:00:00Z'), pr(20, '2026-08-19T00:00:00Z')] })
    expect(result.ok && result.status.phase).toEqual({ kind: 'ready-to-publish', version: '0.3.0' })
    expect(result.ok && result.status.entries.map((e) => e.number)).toEqual([20])
    expect(result.ok && result.status.releases.map((r) => r.tagName)).toEqual(['v0.2.0'])
  })

  it('leaves the window open above while idle, so a later merge is listed', async () => {
    const result = await fetchStatus({ prs: [pr(30, '2026-08-25T00:00:00Z')] })
    expect(result.ok && result.status.entries.map((e) => e.number)).toEqual([30])
  })

  it('gives each release the next one as its previous tag, and shows only twenty of the twenty-one read', async () => {
    const nodes = Array.from({ length: 21 }, (_, index) => ({ tagName: `v0.${String(21 - index)}.0`, name: 'n', url: 'u', publishedAt: null, isDraft: false, isPrerelease: false, isLatest: index === 0, description: '' }))
    const result = await fetchStatus({ state: { releases: { nodes } } })
    if (!result.ok) throw new Error(result.message)
    expect(result.status.releases).toHaveLength(20)
    expect(result.status.releases[0]).toMatchObject({ tagName: 'v0.21.0', previousTag: 'v0.20.0' })
    expect(result.status.releases[19]).toMatchObject({ tagName: 'v0.2.0', previousTag: 'v0.1.0' })
  })

  it('leaves the oldest release without a previous tag and skips a draft between two releases', async () => {
    const release = (tagName: string, isDraft: boolean) => ({ tagName, name: tagName, url: 'u', publishedAt: null, isDraft, isPrerelease: false, isLatest: false, description: '' })
    const result = await fetchStatus({ state: { releases: { nodes: [release('v0.3.0', false), release('v0.2.5', true), release('v0.2.0', false)] } } })
    expect(result.ok && result.status.releases.map((r) => [r.tagName, r.previousTag])).toEqual([
      ['v0.3.0', 'v0.2.0'],
      ['v0.2.0', null],
    ])
  })

  it('returns a guard phase without reading GitHub', async () => {
    const calls: GitHubRequest[] = []
    const result = await fetchStatus({ calls }, { production: null })
    expect(result.ok && result.status.phase.kind).toBe('single-branch')
    expect(calls).toHaveLength(0)
  })

  it('refuses a branch name it will not put in a query', async () => {
    const result = await fetchStatus({}, { integration: 'dev"} { evil' })
    expect(result.ok).toBe(false)
  })

  it('reports a GitHub failure as data', async () => {
    const result = await fetchReleaseStatus({ repo: REPO, integration: 'dev', production: 'main', moduleEnabled: true, config: CONFIG, now: NOW, github: () => Promise.resolve(httpFail('unauthenticated', 401, '', 'GitHub: Bad credentials (HTTP 401)')) })
    expect(result).toEqual({ ok: false, message: 'GitHub: Bad credentials (HTTP 401)', readAt: '2026-09-05T14:00:00.000Z' })
  })
})

describe('release query builders', () => {
  it('requests one release beyond the page shown', () => {
    expect(buildStateQuery(true)).toContain('releases(first: 21,')
  })

  it('never splices a branch or path into the document', () => {
    const query = buildStateQuery(true)
    expect(query).toContain('$integrationFile: String!')
    expect(query).not.toContain('package.json')
    expect(stateVariables({ integration: 'dev', production: 'main', versionFile: 'package.json' })).toMatchObject({ integrationFile: 'dev:package.json', productionFile: 'main:package.json', integrationRef: 'refs/heads/dev' })
  })

  it('sends the bump ref prefix as a variable ending in a slash', () => {
    const query = buildStateQuery(true)
    expect(query).toContain('refPrefix: $bumpRefPrefix')
    expect(query).toContain('$bumpRefPrefix: String!')
    expect(query).not.toContain('refs/heads/bump')
    const prefix = stateVariables({ integration: 'dev', production: 'main', versionFile: null }).bumpRefPrefix
    expect(prefix).toBe('refs/heads/bump/')
    expect(prefix?.endsWith('/')).toBe(true)
  })

  it('drops the file aliases for tags', () => {
    expect(buildStateQuery(false)).not.toContain('integrationFile')
    expect(stateVariables({ integration: 'dev', production: 'main', versionFile: null })).not.toHaveProperty('integrationFile')
  })

  it('reads the tag commit date and the production head date for the PR window', () => {
    const query = buildStateQuery(true)
    expect(query).toContain('tagCommit { committedDate }')
    expect(query).toContain('productionHead: ref(qualifiedName: $productionRef) { target { oid ... on Commit { committedDate } } }')
  })
})

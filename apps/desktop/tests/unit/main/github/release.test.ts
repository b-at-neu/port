import { describe, expect, it } from 'vitest'
import type { GhResult, GhRunner } from '@/types/platform'
import type { ReleaseConfig } from '@/types/release'
import { fetchReleaseStatus } from '@/main/github/release'
import { buildStateQuery, buildTicketsQuery, stateVariables } from '@/main/github/release-query'

const CONFIG: ReleaseConfig = { versionSource: 'package', versionFiles: ['package.json'], versionCommand: null, postPublishHook: null }
const REPO = { owner: 'acme', name: 'widgets' }
const NOW = () => new Date('2026-09-05T14:00:00.000Z')

function ok(stdout: string): GhResult {
  return { ok: true, stdout, stderr: '' }
}

// GitHub's own commit shape: the subject is the first line of the message, parents say merge or not.
function commit(message: string, parents = 1): unknown {
  return { commit: { message }, parents: Array.from({ length: parents }, () => ({ sha: 'p' })) }
}

interface Scenario {
  readonly state?: Record<string, unknown>
  readonly errors?: readonly { path: readonly (string | number)[]; message: string }[]
  readonly compare?: unknown
  readonly log?: unknown
  readonly tickets?: Record<string, unknown>
  readonly calls?: string[][]
}

const STATE = {
  releases: { nodes: [{ tagName: 'v0.2.0', name: 'v0.2.0', url: 'u', publishedAt: '2026-08-01T00:00:00Z', isDraft: false, isPrerelease: false, isLatest: true, description: 'notes' }] },
  openReleasePr: { nodes: [] },
  closedReleasePr: { nodes: [] },
  bumpRefs: { nodes: [] },
  integrationFile: { text: JSON.stringify({ version: '0.2.1-dev' }) },
  productionFile: { text: JSON.stringify({ version: '0.2.0' }) },
  integrationHead: { target: { oid: 'int-oid', tree: { oid: 'int-tree' } } },
  productionHead: { target: { oid: 'prod-oid' } },
}

function runner(scenario: Scenario): GhRunner {
  return (args) => {
    scenario.calls?.push([...args])
    if (args[1] === 'graphql') {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('issueOrPullRequest')) return Promise.resolve(ok(JSON.stringify({ data: { repository: scenario.tickets ?? {} } })))
      return Promise.resolve(ok(JSON.stringify({ data: { repository: { ...STATE, ...scenario.state }, viewer: { login: 'octo-operator' } }, ...(scenario.errors === undefined ? {} : { errors: scenario.errors }) })))
    }
    if (args[1]?.includes('/commits?sha=')) return Promise.resolve(ok(JSON.stringify(scenario.log ?? [])))
    return Promise.resolve(ok(JSON.stringify(scenario.compare ?? { status: 'ahead', total_commits: 2, commits: [] })))
  }
}

function fetchStatus(scenario: Scenario, overrides: Partial<Parameters<typeof fetchReleaseStatus>[0]> = {}) {
  return fetchReleaseStatus({ repo: REPO, integration: 'dev', production: 'main', moduleEnabled: true, config: CONFIG, gh: runner(scenario), now: NOW, ...overrides })
}

describe('fetchReleaseStatus', () => {
  it('gathers the changes since the latest tag, oldest-first compare reversed, and recommends a minor', async () => {
    const calls: string[][] = []
    const result = await fetchStatus({
      calls,
      compare: {
        status: 'ahead',
        total_commits: 3,
        commits: [commit('#10 fix the cache'), commit('#12 add dark mode\n\nbody text'), commit('Merge pull request #13 from a/b', 2)],
      },
      tickets: { t12: { title: 'Add dark mode', labels: { nodes: [{ name: 'enhancement' }] }, author: { __typename: 'User', login: 'a' } }, t10: { title: 'Fix the cache', labels: { nodes: [] }, author: { __typename: 'Bot', login: 'dependabot' } } },
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.status.phase).toEqual({ kind: 'idle' })
    expect(result.status.entries.map((e) => [e.number, e.title, e.dependency])).toEqual([
      [12, 'Add dark mode', false],
      [10, 'Fix the cache', true],
    ])
    expect(result.status.currentVersion).toBe('0.2.0')
    expect(result.status.candidates[0]).toMatchObject({ version: '0.3.0', kind: 'minor', recommended: true })
    expect(result.status.productionHead).toBe('prod-oid')
    expect(result.integrationHead).toEqual({ oid: 'int-oid', tree: 'int-tree' })
    expect(calls.some((call) => call[1] === 'repos/acme/widgets/compare/v0.2.0...dev?per_page=100')).toBe(true)
    expect(result.status.releases).toHaveLength(1)
  })

  it('is nothing-to-release when the gather is empty', async () => {
    const result = await fetchStatus({ compare: { status: 'ahead', total_commits: 0, commits: [] } })
    expect(result.ok && result.status.phase.kind).toBe('nothing-to-release')
  })

  it('notes a truncated compare rather than silently dropping commits', async () => {
    const result = await fetchStatus({ compare: { status: 'ahead', total_commits: 250, commits: [commit('#1 a')] } })
    expect(result.ok && result.status.truncatedNote).toBe('Showing the first 1 commits since v0.2.0.')
  })

  it('falls back to the commit list for a diverged compare', async () => {
    const calls: string[][] = []
    const result = await fetchStatus({ calls, compare: { status: 'diverged', total_commits: 1, commits: [] }, log: [commit('#7 newest'), commit('#6 older')] })
    expect(result.ok && result.status.entries.map((e) => e.number)).toEqual([7, 6])
    expect(calls.some((call) => call[1]?.includes('/commits?sha=dev'))).toBe(true)
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

  it('reads a version from the bump branch and gathers nothing while waiting on a merge', async () => {
    const calls: string[][] = []
    const result = await fetchStatus({ calls, state: { openReleasePr: { nodes: [{ number: 612, url: 'pr', title: 'Release v0.3.0', state: 'OPEN', merged: false }] } } })
    expect(result.ok && result.status.phase).toMatchObject({ kind: 'waiting-merge', version: '0.3.0' })
    expect(calls.filter((call) => call[1] !== 'graphql')).toHaveLength(0)
  })

  it('gathers from production for the release notes when ready to publish, and drops draft releases', async () => {
    const calls: string[][] = []
    const state = {
      closedReleasePr: { nodes: [{ number: 612, url: 'pr', title: 'Release v0.3.0', state: 'MERGED', merged: true }] },
      releases: { nodes: [...STATE.releases.nodes, { tagName: 'v0.4.0', name: 'v0.4.0', url: 'u', publishedAt: null, isDraft: true, isPrerelease: false, isLatest: false, description: '' }] },
    }
    const result = await fetchStatus({ calls, state })
    expect(result.ok && result.status.phase).toEqual({ kind: 'ready-to-publish', version: '0.3.0' })
    expect(calls.some((call) => call[1] === 'repos/acme/widgets/compare/v0.2.0...main?per_page=100')).toBe(true)
    expect(result.ok && result.status.releases.map((r) => r.tagName)).toEqual(['v0.2.0'])
  })

  it('returns a guard phase without reading GitHub', async () => {
    const calls: string[][] = []
    const result = await fetchStatus({ calls }, { production: null })
    expect(result.ok && result.status.phase.kind).toBe('single-branch')
    expect(calls).toHaveLength(0)
  })

  it('refuses a branch name it will not put in a query', async () => {
    const result = await fetchStatus({}, { integration: 'dev"} { evil' })
    expect(result.ok).toBe(false)
  })

  it('reports a GitHub failure as data', async () => {
    const result = await fetchReleaseStatus({ repo: REPO, integration: 'dev', production: 'main', moduleEnabled: true, config: CONFIG, now: NOW, gh: () => Promise.resolve({ ok: false, kind: 'unauthenticated', stdout: '', stderr: 'gh is signed out' }) })
    expect(result).toEqual({ ok: false, message: 'gh is signed out', readAt: '2026-09-05T14:00:00.000Z' })
  })
})

describe('release query builders', () => {
  it('never splices a branch or path into the document', () => {
    const query = buildStateQuery(true)
    expect(query).toContain('$integrationFile: String!')
    expect(query).not.toContain('package.json')
    expect(stateVariables({ integration: 'dev', production: 'main', versionFile: 'package.json' })).toMatchObject({ integrationFile: 'dev:package.json', productionFile: 'main:package.json', integrationRef: 'refs/heads/dev' })
  })

  it('drops the file aliases for tags', () => {
    expect(buildStateQuery(false)).not.toContain('integrationFile')
    expect(stateVariables({ integration: 'dev', production: 'main', versionFile: null })).not.toHaveProperty('integrationFile')
  })

  it('builds one alias per ticket number', () => {
    const query = buildTicketsQuery([12, 10])
    expect(query).toContain('t12: issueOrPullRequest(number: 12)')
    expect(query).toContain('t10: issueOrPullRequest(number: 10)')
    expect(query).toContain('author { __typename login }')
  })
})

// resolveSearchQuery's own tests, split out of ipc.test.ts (#87) once that
// file crossed ENGINEERING §7's 500-line limit -- the same "split by topic"
// remedy scripts/checks.mjs itself follows.
import { describe, expect, it } from 'vitest'
import type { SearchResult } from '../shared/search/types'
import { resolveSearchQuery } from './ipc'
import type { SearchQueryDeps } from './ipc'
import type { RegistryDeps } from './registry'

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveSearchQuery')
  },
  chooseDirectory: () => Promise.resolve(null),
}

function searchQueryDepsWith(overrides: Partial<SearchQueryDeps>): SearchQueryDeps {
  return {
    resolveSessionsScan: () => {
      throw new Error('resolveSessionsScan should not be invoked in this case')
    },
    runSearch: () => {
      throw new Error('runSearch should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveSearchQuery', () => {
  it('rejects a missing query', async () => {
    await expect(resolveSearchQuery(registryDeps, { query: undefined as unknown as string, scope: { kind: 'all' } }, '/data', searchQueryDepsWith({}))).rejects.toThrow(
      "'search:query' requires a non-empty 'query'",
    )
  })

  it('rejects an empty query', async () => {
    await expect(resolveSearchQuery(registryDeps, { query: '', scope: { kind: 'all' } }, '/data', searchQueryDepsWith({}))).rejects.toThrow("'search:query' requires a non-empty 'query'")
  })

  it('rejects a scope that is neither shape', async () => {
    await expect(resolveSearchQuery(registryDeps, { query: 'needle', scope: { kind: 'other' } as never }, '/data', searchQueryDepsWith({}))).rejects.toThrow(
      "'search:query' requires 'scope' to be { kind: 'repo', repoId } or { kind: 'all' }",
    )
  })

  it('rejects a repo scope missing repoId', async () => {
    await expect(resolveSearchQuery(registryDeps, { query: 'needle', scope: { kind: 'repo' } as never }, '/data', searchQueryDepsWith({}))).rejects.toThrow(
      "'search:query' requires 'scope' to be { kind: 'repo', repoId } or { kind: 'all' }",
    )
  })

  it('composes resolveSessionsScan into runSearch, passing the indexDir through', async () => {
    const scan = { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 'now' } as const
    const result: SearchResult = { ok: true, groups: [], inScope: 0, skippedByIndex: 0, read: 0, unreached: 0, complete: true, hitsTruncated: false, indexPersisted: true, tookMs: 1 }
    let received: unknown
    const deps = searchQueryDepsWith({
      resolveSessionsScan: () => Promise.resolve(scan),
      runSearch: (params) => {
        received = params
        return Promise.resolve(result)
      },
    })

    const outcome = await resolveSearchQuery(registryDeps, { query: 'needle', scope: { kind: 'all' } }, '/data', deps)
    expect(outcome).toBe(result)
    expect(received).toEqual({ scan, indexDir: '/data', query: 'needle', scope: { kind: 'all' } })
  })
})

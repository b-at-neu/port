// history.scan and search.query: the scan and search both run in the worker engine.
import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@/types/search'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { fakeEngine, callAction, createTestContext } from '../../../support/context'

const NOT_READY: RepositoryEntry = { id: 'broken' as RepoId, path: '/broken', displayName: 'broken', problem: { kind: 'directory-missing' }, diagnostics: [] }

const SCAN = { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 'now' } as const

describe('history.scan', () => {
  it('rejects when the repositories cannot be listed', async () => {
    const ctx = createTestContext({
      repos: { list: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'nope' }) },
      live: { engine: fakeEngine({ scanSessions: () => Promise.reject(new Error('should not scan')) }) },
    })
    await expect(callAction(ctx, 'history.scan')).rejects.toThrow()
  })

  it('hands the engine only the ready repositories', async () => {
    const received: unknown[] = []
    const ctx = createTestContext({
      repositories: [NOT_READY],
      live: {
        engine: fakeEngine({
          scanSessions: (params) => {
            received.push(params)
            return Promise.resolve(SCAN)
          },
        }),
      },
    })
    await callAction(ctx, 'history.scan')
    expect(received).toEqual([{ repos: [] }])
  })
})

describe('search.query', () => {
  it('returns the engine result, passing the index directory through', async () => {
    const result: SearchResult = { ok: true, groups: [], inScope: 0, skippedByIndex: 0, read: 0, unreached: 0, complete: true, hitsTruncated: false, indexPersisted: true, tookMs: 1 }
    const received: unknown[] = []
    const ctx = createTestContext({
      live: {
        engine: fakeEngine({
          scanSessions: () => Promise.resolve(SCAN),
          search: (params) => {
            received.push(params)
            return Promise.resolve(result)
          },
        }),
      },
    })
    await expect(callAction(ctx, 'search.query', { query: 'needle', scope: { kind: 'all' } })).resolves.toBe(result)
    expect(received).toEqual([{ scan: SCAN, indexDir: ctx.paths.userData, query: 'needle', scope: { kind: 'all' } }])
  })
})

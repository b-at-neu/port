import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { HostedStore } from '@/types/hosting'
import { createDispatchRuntime } from '@/main/dispatch/runtime'
import { DISPATCH_STORE_DEFAULTS, storeStub } from '../../../fixtures/store'

function fakeStore(overrides: Partial<HostedStore> = {}): HostedStore {
  return storeStub({ ...DISPATCH_STORE_DEFAULTS, ...overrides })
}

describe('createDispatchRuntime', () => {
  it('once bound, onChange calls the republish function', async () => {
    let called = false
    const runtime = createDispatchRuntime({
      store: fakeStore(),
      launch: null,
      runState: () => 'dispatching',
      readOwnership: () => Promise.resolve({ kind: 'app', since: '2026-01-01T00:00:00Z', path: 'p', readAt: 'r' }),
      takeOwnership: () => Promise.resolve({ ok: true, path: 'p' }),
      fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: 'r' }),
      listRepositories: () =>
        Promise.resolve({
          ok: true,
          repositories: [
            {
              id: 'repo-a' as RepoId,
              path: '/repo',
              displayName: 'o/a',
              status: 'ready',
              config: {
                repo: 'o/a',
                owner: 'o',
                name: 'a',
                branches: { integration: 'dev', production: 'main' },
                commands: { worktrees: null, budget: null },
                concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
                checkDispositions: {},
                overrides: [],
                models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
                modules: { approvalGate: true, release: true, scope: true },
                reviewCycleCap: 5,
                vocabulary: { labels: [], disabled: [], problems: [] },
              },
              diagnostics: [],
            },
          ],
        }),
      registryDeps: { registryDir: '/r', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
      dirs: { audit: '/audit', scratch: '/scratch' },
      now: () => new Date('2026-01-01T00:00:00Z'),
    })
    runtime.bindWatcher(() => {
      called = true
    })
    await runtime.dispatcher.consider({ state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' }, readAt: 't' }, health: [], policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 }, tick: [], runStates: { store: { kind: 'loaded' }, repositories: [] }, nextWakeupAt: null, emittedAt: 't', dispatch: [] })
    expect(called).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot, HostedStore, SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import type { RefreshRequest } from '@/types/state'
import { createDispatchRuntime } from '@/main/dispatch/runtime'
import { DISPATCH_STORE_DEFAULTS, storeStub } from '../../../fixtures/store'

const REPO_ID = 'repo-a' as RepoId
const SESSION_KEY = 'hosted-1' as SessionKey

const COMPLETED: StageOutcome = { kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed', operatorJoined: false }

function fakeStore(overrides: Partial<HostedStore> = {}): HostedStore {
  return storeStub({ ...DISPATCH_STORE_DEFAULTS, ...overrides })
}

function runtimeDeps(overrides: Partial<Parameters<typeof createDispatchRuntime>[0]> = {}): Parameters<typeof createDispatchRuntime>[0] {
  return {
    store: fakeStore({ snapshotOf: () => ({ phase: 'ready', end: null }) as unknown as HostedSessionSnapshot }),
    launch: { launch: () => Promise.resolve({ ok: true, sessionKey: SESSION_KEY }) },
    runState: () => 'dispatching',
    readOwnership: () => Promise.resolve({ kind: 'app', since: '2026-01-01T00:00:00Z', path: 'p', readAt: 'r' }),
    takeOwnership: () => Promise.resolve({ ok: true, path: 'p' }),
    fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
    listRepositories: () =>
      Promise.resolve({
        ok: true,
        repositories: [
          {
            id: REPO_ID,
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
              vocabulary: resolveVocabulary({}),
            },
            diagnostics: [],
          },
        ],
      }),
    registryDeps: { registryDir: '/r', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
    dirs: { audit: '/audit', scratch: '/scratch' },
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

const SNAPSHOT = {
  state: {
    repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op' }],
    sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' },
    readAt: 't',
  },
  health: [],
  policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
  tick: [{ repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [] }],
  runStates: { store: { kind: 'loaded' }, repositories: [] },
  nextWakeupAt: null,
  emittedAt: 't',
  dispatch: [],
} as unknown as BoardSnapshot

describe('createDispatchRuntime', () => {
  it('once bound, onChange calls the republish function', async () => {
    let republished = false
    const runtime = createDispatchRuntime(runtimeDeps())
    runtime.bindWatcher({
      republish: () => {
        republished = true
      },
      refresh: () => Promise.resolve(SNAPSHOT),
    })
    await runtime.dispatcher.consider(SNAPSHOT)
    expect(republished).toBe(true)
  })

  it('a completed hand-back reaches the watcher as one github-scoped refresh of that repository', async () => {
    const refreshes: (RefreshRequest | undefined)[] = []
    const runtime = createDispatchRuntime(runtimeDeps())
    runtime.bindWatcher({
      republish: () => undefined,
      refresh: (request) => {
        refreshes.push(request)
        return Promise.resolve(SNAPSHOT)
      },
    })
    await runtime.dispatcher.consider(SNAPSHOT)
    expect(refreshes).toEqual([])

    runtime.dispatcher.recordOutcome(REPO_ID, SESSION_KEY, COMPLETED)
    expect(refreshes).toEqual([{ repoId: REPO_ID, source: 'github' }])
  })

  it('a hand-back before the watcher is bound requests nothing and throws nothing', async () => {
    const runtime = createDispatchRuntime(runtimeDeps())
    await runtime.dispatcher.consider(SNAPSHOT)
    expect(() => runtime.dispatcher.recordOutcome(REPO_ID, SESSION_KEY, COMPLETED)).not.toThrow()
  })
})

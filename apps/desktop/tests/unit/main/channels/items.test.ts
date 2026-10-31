import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReposListResponse } from '@/types/ipc'
import type { BoardSnapshot } from '@/types/board'
import { resolveItemAction, resolveItemDecision } from '@/main/channels/items'
import type { ItemActionDeps } from '@/main/channels/items'
import type { ItemDecisionDeps } from '@/types/channels'
import type { RegistryDeps } from '@/types/registry'
import { stageSession } from '../../../fixtures/stage-session'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: {} as never,
    commands: { worktrees: 'node scripts/worktrees.mjs', budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

const NOT_READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  problem: { kind: 'directory-missing' as const },
  diagnostics: [],
}

const EMPTY_SNAPSHOT: BoardSnapshot = {
  state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' }, readAt: 't' },
  health: [],
  policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
  tick: [],
  runStates: { store: { kind: 'loaded' }, repositories: [] },
  nextWakeupAt: null,
  emittedAt: 't',
  dispatch: [],
  autoPlan: [],
}

function itemActionDepsWith(overrides: Partial<ItemActionDeps>): ItemActionDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    applyItemAction: () => {
      throw new Error('applyItemAction should not be invoked in this case')
    },
    snapshot: () => EMPTY_SNAPSHOT,
    refresh: () => {
      throw new Error('refresh should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveItemAction', () => {
  it('rejects a missing repoId', async () => {
    await expect(
      resolveItemAction(registryDeps, { repoId: undefined as unknown as RepoId, kind: 'issue', number: 1, action: 'pause', expectedStage: null }, '/audit', itemActionDepsWith({})),
    ).rejects.toThrow("'item:action' requires a non-empty 'repoId'")
  })

  it('rejects a kind outside issue/pull-request', async () => {
    await expect(
      resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'bogus' as never, number: 1, action: 'pause', expectedStage: null }, '/audit', itemActionDepsWith({})),
    ).rejects.toThrow("'item:action' requires 'kind' to be 'issue' or 'pull-request'")
  })

  it('rejects a non-positive number', async () => {
    await expect(
      resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 0, action: 'pause', expectedStage: null }, '/audit', itemActionDepsWith({})),
    ).rejects.toThrow("'item:action' requires 'number' to be a positive integer")
  })

  it('rejects an action outside OPERATOR_ACTIONS', async () => {
    await expect(
      resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 1, action: 'bogus' as never, expectedStage: null }, '/audit', itemActionDepsWith({})),
    ).rejects.toThrow("'item:action' requires 'action' to be one of pause, resume, retry, stop, gate, refresh")
  })

  it('rejects an empty-string expectedStage', async () => {
    await expect(
      resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 1, action: 'pause', expectedStage: '' as never }, '/audit', itemActionDepsWith({})),
    ).rejects.toThrow("'item:action' requires 'expectedStage' to be a non-empty string or null")
  })

  it('rejects an unregistered repoId', async () => {
    await expect(
      resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 1, action: 'pause', expectedStage: null }, '/audit', itemActionDepsWith({})),
    ).rejects.toThrow(`'item:action' found no repository registered with id '${REPO_ID}'`)
  })

  it('rejects a non-ready repository', async () => {
    const deps = itemActionDepsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 1, action: 'pause', expectedStage: null }, '/audit', deps)).rejects.toThrow(
      "'item:action' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('passes a valid request through to applyItemAction, and does not refresh on a non-applied outcome', async () => {
    let refreshCalls = 0
    const deps = itemActionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'no-op' } }),
      refresh: () => {
        refreshCalls++
        return Promise.resolve(EMPTY_SNAPSHOT)
      },
    })
    const result = await resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 148, action: 'pause', expectedStage: 'planApproved' }, '/audit', deps)
    expect(result).toEqual({ ok: true, outcome: { kind: 'no-op' } })
    expect(refreshCalls).toBe(0)
  })

  it('forces a github refresh after an applied outcome, before returning', async () => {
    let refreshCalls = 0
    const deps = itemActionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }),
      refresh: (request) => {
        refreshCalls++
        expect(request).toEqual({ repoId: REPO_ID, source: 'github' })
        return Promise.resolve(EMPTY_SNAPSHOT)
      },
    })
    const result = await resolveItemAction(registryDeps, { repoId: REPO_ID, kind: 'issue', number: 148, action: 'pause', expectedStage: 'planApproved' }, '/audit', deps)
    expect(result).toEqual({ ok: true, outcome: { kind: 'applied', argv: [] } })
    expect(refreshCalls).toBe(1)
  })
})

function itemDecisionDepsWith(overrides: Partial<ItemDecisionDeps>): ItemDecisionDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    applyItemDecision: () => {
      throw new Error('applyItemDecision should not be invoked in this case')
    },
    sessions: () => [],
    snapshot: () => EMPTY_SNAPSHOT,
    refresh: () => {
      throw new Error('refresh should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveItemDecision', () => {
  it('rejects a missing repoId', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: undefined as unknown as RepoId, number: 1, decision: 'unblock', expectedStage: null, route: 'revision', note: null, skipComment: false, picks: null },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires a non-empty 'repoId'")
  })

  it('rejects a decision outside OPERATOR_DECISIONS', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'bogus' as never, expectedStage: null, route: null, note: null, skipComment: false, picks: null },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'decision' to be one of unblock, revise")
  })

  it('rejects unblock with a route outside UNBLOCK_ROUTES', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'unblock', expectedStage: null, route: 'bogus' as never, note: null, skipComment: false, picks: null },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'route' to be one of revision, review, implementation for 'unblock'")
  })

  it('accepts the implementation route', async () => {
    let forwarded: unknown = null
    const deps = itemDecisionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      applyItemDecision: (params) => {
        forwarded = params.request.route
        return Promise.resolve({ ok: true, comment: null, labels: { kind: 'no-op' } })
      },
    })
    await resolveItemDecision(
      registryDeps,
      { repoId: REPO_ID, number: 51, decision: 'unblock', expectedStage: 'blocked', route: 'implementation', note: null, skipComment: false, picks: null },
      '/audit',
      '/scratch',
      deps,
    )
    expect(forwarded).toBe('implementation')
  })

  it.each([
    ['a live session for this number', [stageSession({ repoId: REPO_ID, stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' } })], true],
    ['an ended session for this number', [stageSession({ repoId: REPO_ID, phase: 'ended', stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' } })], false],
    ['a live session for another number', [stageSession({ repoId: REPO_ID, stage: { agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved' } })], false],
    ['a live session in another repository', [stageSession({ repoId: 'repo-2' as unknown as RepoId, stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' } })], false],
  ])('reads liveStage from the hosted store: %s', async (_name, sessions, expected) => {
    let liveStage: boolean | null = null
    const deps = itemDecisionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      sessions: () => sessions,
      applyItemDecision: (params) => {
        liveStage = params.liveStage
        return Promise.resolve({ ok: true, comment: null, labels: { kind: 'no-op' } })
      },
    })
    await resolveItemDecision(
      registryDeps,
      { repoId: REPO_ID, number: 51, decision: 'unblock', expectedStage: 'blocked', route: 'implementation', note: null, skipComment: false, picks: null },
      '/audit',
      '/scratch',
      deps,
    )
    expect(liveStage).toBe(expected)
  })

  it('rejects unblock carrying a note', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'unblock', expectedStage: null, route: 'revision', note: 'oops', skipComment: false, picks: null },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'note' to be null for 'unblock'")
  })

  it('rejects revise carrying a route', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'revise', expectedStage: null, route: 'revision', note: 'change this', skipComment: false, picks: null },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'route' to be null for 'revise'")
  })

  it('rejects revise without a string note', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'revise', expectedStage: null, route: null, note: null, skipComment: false, picks: null },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'note' to be a string of at most 10000 characters for 'revise'")
  })

  it.each([
    ['a non-array', 'D1' as never],
    ['an entry with a malformed id', [{ id: 'one', letter: 'A' }] as never],
    ['an entry with a lowercase letter', [{ id: 'D1', letter: 'a' }] as never],
    ['more than twenty entries', Array.from({ length: 21 }, (_, i) => ({ id: `D${String(i + 1)}`, letter: 'A' })) as never],
  ])('rejects unblock with picks that are %s', async (_name, picks) => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'unblock', expectedStage: null, route: 'revision', note: null, skipComment: false, picks },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'picks' to be null or at most 20")
  })

  it('rejects revise carrying picks', async () => {
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'revise', expectedStage: null, route: null, note: 'change this', skipComment: false, picks: [{ id: 'D1', letter: 'A' }] },
        '/audit',
        '/scratch',
        itemDecisionDepsWith({}),
      ),
    ).rejects.toThrow("'item:decide' requires 'picks' to be null for 'revise'")
  })

  it('forwards well-formed picks to applyItemDecision', async () => {
    let forwarded: unknown = null
    const deps = itemDecisionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      applyItemDecision: (params) => {
        forwarded = params.request.picks
        return Promise.resolve({ ok: true, comment: null, labels: { kind: 'no-op' } })
      },
    })
    await resolveItemDecision(
      registryDeps,
      { repoId: REPO_ID, number: 148, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: [{ id: 'D1', letter: 'B' }] },
      '/audit',
      '/scratch',
      deps,
    )
    expect(forwarded).toEqual([{ id: 'D1', letter: 'B' }])
  })

  it('rejects a non-ready repository', async () => {
    const deps = itemDecisionDepsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(
      resolveItemDecision(
        registryDeps,
        { repoId: REPO_ID, number: 1, decision: 'unblock', expectedStage: null, route: 'revision', note: null, skipComment: false, picks: null },
        '/audit',
        '/scratch',
        deps,
      ),
    ).rejects.toThrow("'item:decide' requires a 'ready' repository, got 'directory-missing'")
  })

  it('forces a github refresh after an applied label outcome, before returning', async () => {
    let refreshCalls = 0
    const deps = itemDecisionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      applyItemDecision: () => Promise.resolve({ ok: true, comment: { kind: 'applied', argv: [] }, labels: { kind: 'applied', argv: [] } }),
      refresh: (request) => {
        refreshCalls++
        expect(request).toEqual({ repoId: REPO_ID, source: 'github' })
        return Promise.resolve(EMPTY_SNAPSHOT)
      },
    })
    const result = await resolveItemDecision(
      registryDeps,
      { repoId: REPO_ID, number: 148, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null },
      '/audit',
      '/scratch',
      deps,
    )
    expect(result.ok).toBe(true)
    expect(refreshCalls).toBe(1)
  })

  it('does not refresh when the label outcome is not applied', async () => {
    let refreshCalls = 0
    const deps = itemDecisionDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      applyItemDecision: () => Promise.resolve({ ok: true, comment: null, labels: { kind: 'no-op' } }),
      refresh: () => {
        refreshCalls++
        return Promise.resolve(EMPTY_SNAPSHOT)
      },
    })
    await resolveItemDecision(
      registryDeps,
      { repoId: REPO_ID, number: 148, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null },
      '/audit',
      '/scratch',
      deps,
    )
    expect(refreshCalls).toBe(0)
  })
})

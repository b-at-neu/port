import { describe, expect, it } from 'vitest'
import type { RepoId } from '../shared/repos'
import type { ReposListResponse } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import type { BoardSnapshot } from '../shared/board/types'
import { resolveBoardRefresh, resolveClaimApply, resolveClaimPreflight, resolveItemAction, resolveWorktreesReport } from './ipc'
import type { BoardRefreshDeps, ItemActionDeps, WorktreesReportDeps } from './ipc'
import type { ClaimDeps } from './claim'
import type { RegistryDeps } from './registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveWorktreesReport')
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
    commands: { worktrees: 'node scripts/worktrees.mjs' },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
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

function depsWith(overrides: Partial<WorktreesReportDeps>): WorktreesReportDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    readWorktreeReport: () => {
      throw new Error('readWorktreeReport should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveWorktreesReport', () => {
  it('rejects a missing id', async () => {
    await expect(resolveWorktreesReport(registryDeps, { id: undefined as unknown as RepoId }, depsWith({}))).rejects.toThrow(
      "'worktrees:report' requires a non-empty 'id'",
    )
  })

  it('rejects an empty id', async () => {
    await expect(resolveWorktreesReport(registryDeps, { id: '' as unknown as RepoId }, depsWith({}))).rejects.toThrow(
      "'worktrees:report' requires a non-empty 'id'",
    )
  })

  it('surfaces a registry that could not be listed', async () => {
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }),
    })
    await expect(resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)).rejects.toThrow(
      "'worktrees:report' could not list repositories: disk on fire",
    )
  })

  it('rejects an id with no matching repository', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)).rejects.toThrow(
      `'worktrees:report' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)).rejects.toThrow(
      "'worktrees:report' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('reads the report for a ready repository, passing its resolved path and command through', async () => {
    const report: WorktreesReport = { ok: false, kind: 'timeout', message: 'node timed out after 60000ms', readAt: '2026-01-01T00:00:00.000Z' }
    let received: unknown
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      readWorktreeReport: (params) => {
        received = params
        return Promise.resolve(report)
      },
    })
    const result = await resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)
    expect(result).toBe(report)
    expect(received).toEqual({
      repoRoot: '/repo',
      worktreesCommand: 'node scripts/worktrees.mjs',
      git: registryDeps.git,
    })
  })
})

const FAKE_SNAPSHOT = { state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00.000Z' }, readAt: '2026-01-01T00:00:00.000Z' }, health: [], policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 }, tick: [], nextWakeupAt: null, emittedAt: '2026-01-01T00:00:00.000Z' } satisfies BoardSnapshot

function boardDepsWith(overrides: Partial<BoardRefreshDeps>): BoardRefreshDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    refresh: () => Promise.resolve(FAKE_SNAPSHOT),
    ...overrides,
  }
}

describe('resolveBoardRefresh', () => {
  it('rejects an id with no matching repository', async () => {
    const deps = boardDepsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveBoardRefresh(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      `'board:refresh' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects an unknown source', async () => {
    const deps = boardDepsWith({})
    await expect(resolveBoardRefresh(registryDeps, { source: 'bogus' as never }, deps)).rejects.toThrow(
      "'board:refresh' source must be one of github, sessions, worktrees, denials",
    )
  })

  it('surfaces a registry that could not be listed when repoId is present', async () => {
    const deps = boardDepsWith({ listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }) })
    await expect(resolveBoardRefresh(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      "'board:refresh' could not list repositories: disk on fire",
    )
  })

  it('forwards a valid request to refresh() and returns its snapshot', async () => {
    const deps = boardDepsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }), refresh: () => Promise.resolve(FAKE_SNAPSHOT) })
    const result = await resolveBoardRefresh(registryDeps, { repoId: REPO_ID, source: 'github' }, deps)
    expect(result).toBe(FAKE_SNAPSHOT)
  })

  it('an empty request (no repoId, no source) forces every source', async () => {
    let received: unknown
    const deps = boardDepsWith({
      refresh: (request) => {
        received = request
        return Promise.resolve(FAKE_SNAPSHOT)
      },
    })
    await resolveBoardRefresh(registryDeps, {}, deps)
    expect(received).toEqual({})
  })
})

function claimDepsWith(overrides: Partial<ClaimDeps>): ClaimDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    fetchClaimPreflight: () => {
      throw new Error('fetchClaimPreflight should not be invoked in this case')
    },
    applyClaimLabels: () => {
      throw new Error('applyClaimLabels should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveClaimPreflight', () => {
  it('rejects a missing repoId', async () => {
    await expect(resolveClaimPreflight(registryDeps, { repoId: undefined as unknown as RepoId, number: 1 }, claimDepsWith({}))).rejects.toThrow(
      "'claim:preflight' requires a non-empty 'repoId'",
    )
  })

  it('rejects a non-integer number', async () => {
    await expect(resolveClaimPreflight(registryDeps, { repoId: REPO_ID, number: 1.5 }, claimDepsWith({}))).rejects.toThrow(
      "'claim:preflight' requires 'number' to be a positive integer",
    )
  })

  it('rejects a non-positive number', async () => {
    await expect(resolveClaimPreflight(registryDeps, { repoId: REPO_ID, number: 0 }, claimDepsWith({}))).rejects.toThrow(
      "'claim:preflight' requires 'number' to be a positive integer",
    )
  })

  it('passes a valid request through to claimPreflight', async () => {
    const deps = claimDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      fetchClaimPreflight: () =>
        Promise.resolve({ ok: true, viewer: 'alice', fetchedAt: 't', item: null }),
    })
    const result = await resolveClaimPreflight(registryDeps, { repoId: REPO_ID, number: 93 }, deps)
    expect(result).toEqual({ kind: 'unresolved' })
  })
})

describe('resolveClaimApply', () => {
  it('rejects a missing repoId', async () => {
    await expect(
      resolveClaimApply(registryDeps, { repoId: undefined as unknown as RepoId, number: 1, planGate: 'review', confirmedAssignees: [] }, '/audit', claimDepsWith({})),
    ).rejects.toThrow("'claim:apply' requires a non-empty 'repoId'")
  })

  it('rejects a non-integer number', async () => {
    await expect(
      resolveClaimApply(registryDeps, { repoId: REPO_ID, number: 1.5, planGate: 'review', confirmedAssignees: [] }, '/audit', claimDepsWith({})),
    ).rejects.toThrow("'claim:apply' requires 'number' to be a positive integer")
  })

  it('rejects a planGate outside PLAN_GATE_CHOICES', async () => {
    await expect(
      resolveClaimApply(registryDeps, { repoId: REPO_ID, number: 1, planGate: 'bogus' as never, confirmedAssignees: [] }, '/audit', claimDepsWith({})),
    ).rejects.toThrow("'claim:apply' requires 'planGate' to be one of review, auto")
  })

  it('rejects confirmedAssignees that is not an array of strings', async () => {
    await expect(
      resolveClaimApply(registryDeps, { repoId: REPO_ID, number: 1, planGate: 'review', confirmedAssignees: [1 as never] }, '/audit', claimDepsWith({})),
    ).rejects.toThrow("'claim:apply' requires 'confirmedAssignees' to be an array of strings")
  })

  it('passes a valid request through to claimApply', async () => {
    const deps = claimDepsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      fetchClaimPreflight: () =>
        Promise.resolve({ ok: true, viewer: 'alice', fetchedAt: 't', item: null }),
    })
    const result = await resolveClaimApply(registryDeps, { repoId: REPO_ID, number: 93, planGate: 'review', confirmedAssignees: [] }, '/audit', deps)
    expect(result).toEqual({ kind: 'refused', verdict: { kind: 'not-found' } })
  })
})

const EMPTY_SNAPSHOT: BoardSnapshot = {
  state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' }, readAt: 't' },
  health: [],
  policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
  tick: [],
  nextWakeupAt: null,
  emittedAt: 't',
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
    ).rejects.toThrow("'item:action' requires 'action' to be one of pause, resume, retry, gate")
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

import { describe, expect, it } from 'vitest'
import type { RepoId } from '../shared/repos'
import type { ReposListResponse } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import type { BoardSnapshot } from '../shared/board/types'
import { resolveBoardRefresh, resolveWorktreesReport } from './ipc'
import type { BoardRefreshDeps, WorktreesReportDeps } from './ipc'
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

const FAKE_SNAPSHOT = { state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00.000Z' }, readAt: '2026-01-01T00:00:00.000Z' }, health: [], policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 }, emittedAt: '2026-01-01T00:00:00.000Z' } satisfies BoardSnapshot

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

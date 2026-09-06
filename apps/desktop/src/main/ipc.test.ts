import { describe, expect, it } from 'vitest'
import type { RepoId } from '../shared/repos'
import type { ReposListResponse } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import { resolveWorktreesReport } from './ipc'
import type { WorktreesReportDeps } from './ipc'
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

import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReposListResponse } from '@/types/ipc'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { resolveAuditList } from '@/main/channels/audit'
import type { AuditListDeps } from '@/main/channels/audit'
import type { RegistryDeps } from '@/types/registry'
import type { AuditRead, ReadAuditLogParams } from '@/types/writes'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveAuditList')
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
    vocabulary: resolveVocabulary({}),
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

const READ: AuditRead = { ok: true, entries: [], malformed: 0, previousPath: null, readAt: 't' }

function depsWith(overrides: Partial<AuditListDeps>): AuditListDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    readAuditLog: () => {
      throw new Error('readAuditLog should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveAuditList', () => {
  it('reads every repository when repoId is null', async () => {
    let received: { dir: string; params: ReadAuditLogParams | undefined } | undefined
    const deps = depsWith({
      readAuditLog: (dir, params) => {
        received = { dir, params }
        return Promise.resolve(READ)
      },
    })
    expect(await resolveAuditList(registryDeps, { repoId: null, number: null }, '/user-data', deps)).toBe(READ)
    expect(received).toEqual({ dir: '/user-data', params: { limit: 500 } })
  })

  it('passes the ready repository slug, number and limit to readAuditLog', async () => {
    let received: ReadAuditLogParams | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      readAuditLog: (_dir, params) => {
        received = params
        return Promise.resolve(READ)
      },
    })
    await resolveAuditList(registryDeps, { repoId: REPO_ID, number: 38 }, '/user-data', deps)
    expect(received).toEqual({ repo: 'acme/widgets', number: 38, limit: 500 })
  })

  it('omits number for a repository-wide read', async () => {
    let received: ReadAuditLogParams | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      readAuditLog: (_dir, params) => {
        received = params
        return Promise.resolve(READ)
      },
    })
    await resolveAuditList(registryDeps, { repoId: REPO_ID, number: null }, '/user-data', deps)
    expect(received).toEqual({ repo: 'acme/widgets', limit: 500 })
  })

  it('rejects an id with no matching repository', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveAuditList(registryDeps, { repoId: REPO_ID, number: null }, '/user-data', deps)).rejects.toThrow(`'audit:list' found no repository registered with id '${REPO_ID}'`)
  })

  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(resolveAuditList(registryDeps, { repoId: REPO_ID, number: null }, '/user-data', deps)).rejects.toThrow("'audit:list' requires a 'ready' repository, got 'directory-missing'")
  })

  it('rejects a number without a repoId', async () => {
    await expect(resolveAuditList(registryDeps, { repoId: null, number: 38 }, '/user-data', depsWith({}))).rejects.toThrow("'audit:list' requires a positive integer 'number'")
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects number %j', async (number) => {
    await expect(resolveAuditList(registryDeps, { repoId: REPO_ID, number }, '/user-data', depsWith({}))).rejects.toThrow("'audit:list' requires a positive integer 'number'")
  })
})

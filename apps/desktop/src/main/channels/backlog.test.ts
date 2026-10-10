import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { ReposListResponse } from '../../shared/ipc'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import { resolveBacklogList } from './backlog'
import type { BacklogListDeps } from './backlog'
import type { RegistryDeps } from '../registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveBacklogList')
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

function depsWith(overrides: Partial<BacklogListDeps>): BacklogListDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    fetchBacklog: () => {
      throw new Error('fetchBacklog should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveBacklogList', () => {
  it('rejects a missing repoId', async () => {
    await expect(resolveBacklogList(registryDeps, { repoId: undefined as unknown as RepoId }, depsWith({}))).rejects.toThrow(
      "'backlog:list' requires a non-empty 'repoId'",
    )
  })

  it('surfaces a registry that could not be listed', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }) })
    await expect(resolveBacklogList(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      "'backlog:list' could not list repositories: disk on fire",
    )
  })

  it('rejects an id with no matching repository', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveBacklogList(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      `'backlog:list' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(resolveBacklogList(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      "'backlog:list' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('forwards the ready repository repo and vocabulary to fetchBacklog', async () => {
    let received: unknown
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      fetchBacklog: (params) => {
        received = params
        return Promise.resolve({ ok: true, items: [], scanned: 0, total: 0, viewer: 'octo-dev', fetchedAt: 't' })
      },
    })
    const result = await resolveBacklogList(registryDeps, { repoId: REPO_ID }, deps)
    expect(result).toEqual({ ok: true, items: [], scanned: 0, total: 0, viewer: 'octo-dev', fetchedAt: 't' })
    expect(received).toEqual({ repo: { owner: 'acme', name: 'widgets' }, vocabulary: READY_ENTRY.config.vocabulary })
  })
})

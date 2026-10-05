import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { ReposListResponse } from '../../shared/ipc'
import { resolveClaimApply, resolveClaimPreflight } from './claim'
import type { ClaimDeps } from '../claim'
import type { RegistryDeps } from '../registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveClaimPreflight/resolveClaimApply')
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
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

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

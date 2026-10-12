import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ClaimPreflightFetch } from '@/types/github'
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import type { ReposListResponse } from '@/types/ipc'
import { claimApply, claimPreflight } from '@/main/claim'
import type { ClaimDeps } from '@/types/claim'
import type { RegistryDeps } from '@/types/registry'
import { readyEntry } from '../../fixtures/board-state'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by claim.ts')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = readyEntry({ id: REPO_ID, displayName: 'widgets' }, { repo: 'acme/widgets', owner: 'acme', name: 'widgets', reviewCycleCap: 3 })

const NOT_READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  problem: { kind: 'directory-missing' as const },
  diagnostics: [],
}

function depsWith(overrides: Partial<ClaimDeps>): ClaimDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] } as ReposListResponse),
    fetchClaimPreflight: () => {
      throw new Error('fetchClaimPreflight should not be invoked in this case')
    },
    applyClaimLabels: () => {
      throw new Error('applyClaimLabels should not be invoked in this case')
    },
    ...overrides,
  }
}

function preflightFetch(overrides: Partial<Extract<ClaimPreflightFetch, { ok: true }>> = {}): Extract<ClaimPreflightFetch, { ok: true }> {
  return {
    ok: true,
    viewer: 'alice',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    item: { kind: 'issue', number: 93, title: 't', url: 'u', state: 'OPEN', labels: [], assignees: [], blockers: { ok: true, open: [], shown: 0, total: 0 } },
    ...overrides,
  }
}

describe('claimPreflight', () => {
  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(claimPreflight({ registryDeps, repoId: REPO_ID, number: 93 }, deps)).rejects.toThrow(
      "claim requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('surfaces a fetch failure as kind: failed', async () => {
    const deps = depsWith({ fetchClaimPreflight: () => Promise.resolve({ ok: false, kind: 'network', message: 'dial tcp', fetchedAt: 't' }) })
    const result = await claimPreflight({ registryDeps, repoId: REPO_ID, number: 93 }, deps)
    expect(result).toEqual({ kind: 'failed', message: 'dial tcp' })
  })

  it('reports unresolved for a number that does not exist', async () => {
    const deps = depsWith({ fetchClaimPreflight: () => Promise.resolve(preflightFetch({ item: null })) })
    const result = await claimPreflight({ registryDeps, repoId: REPO_ID, number: 999999 }, deps)
    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('resolves a claimable item with its verdict', async () => {
    const deps = depsWith({ fetchClaimPreflight: () => Promise.resolve(preflightFetch()) })
    const result = await claimPreflight({ registryDeps, repoId: REPO_ID, number: 93 }, deps)
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.viewer).toBe('alice')
    expect(result.verdict).toEqual({ kind: 'claimable', assigneeSituation: 'unassigned', others: [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 } })
  })
})

describe('claimApply', () => {
  it('refuses without writing when the fresh verdict is no longer claimable', async () => {
    const deps = depsWith({ fetchClaimPreflight: () => Promise.resolve(preflightFetch({ item: null })) })
    const result = await claimApply({ registryDeps, repoId: REPO_ID, number: 93, planGate: 'review', confirmedAssignees: [], auditDir: '/audit' }, deps)
    expect(result).toEqual({ kind: 'refused', verdict: { kind: 'not-found' } })
  })

  it('refuses as moved when the fresh assignee set disagrees with what was confirmed', async () => {
    const deps = depsWith({
      fetchClaimPreflight: () => Promise.resolve(preflightFetch({ item: { ...preflightFetch().item!, assignees: ['bob'] } })),
    })
    const result = await claimApply({ registryDeps, repoId: REPO_ID, number: 93, planGate: 'review', confirmedAssignees: [], auditDir: '/audit' }, deps)
    expect(result).toEqual({ kind: 'moved', confirmed: [], current: ['bob'], readAt: '2026-01-01T00:00:00.000Z' })
  })

  it('builds the request and forwards applyLabels\' outcome unchanged, when confirmed and fresh assignees agree', async () => {
    let received: LabelWriteRequest | undefined
    const outcome: WriteOutcome = { kind: 'applied', argv: ['issue', 'edit', '93'] }
    const deps = depsWith({
      fetchClaimPreflight: () => Promise.resolve(preflightFetch()),
      applyClaimLabels: (params) => {
        received = params.request
        return Promise.resolve(outcome)
      },
    })
    const result = await claimApply({ registryDeps, repoId: REPO_ID, number: 93, planGate: 'auto', confirmedAssignees: [], auditDir: '/audit' }, deps)
    expect(result).toEqual({ kind: 'write', outcome })
    expect(received?.add).toEqual(['marker', 'ready', 'autoPlan'])
    expect(received?.addAssignees).toEqual(['alice'])
    expect(received?.repo).toBe('acme/widgets')
  })

  it('surfaces an unreachable preflight as preflight-failed, without writing', async () => {
    const deps = depsWith({ fetchClaimPreflight: () => Promise.resolve({ ok: false, kind: 'unauthenticated', message: 'gh: 401', fetchedAt: 't' }) })
    const result = await claimApply({ registryDeps, repoId: REPO_ID, number: 93, planGate: 'review', confirmedAssignees: [], auditDir: '/audit' }, deps)
    expect(result).toEqual({ kind: 'preflight-failed', message: 'gh: 401' })
  })
})

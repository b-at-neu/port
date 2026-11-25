import { describe, expect, it, vi } from 'vitest'
import { resolveIncidentExport, resolveIncidentGroups, resolveIncidentList } from '@/main/features/incidents/resolve'
import type { IncidentChannelDeps } from '@/main/app/seams'
import type { IncidentRead, IncidentRecord } from '@/types/incidents'
import type { ReposListResponse } from '@/types/ipc'
import type { RegistryDeps } from '@/types/registry'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = { registryDir: '/registry', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) }

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
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

function record(id: string, repo: string, number: number, signature: string, at: string): IncidentRecord {
  const [bucket] = signature.split(':')
  return {
    v: 1,
    id,
    at,
    repo,
    number,
    kind: 'pull-request',
    bucket: bucket as IncidentRecord['bucket'],
    signature,
    decision: { action: 'observe-zero-diff', detail: null, intended: null },
    inputs: {},
    outcome: { kind: 'applied' },
    related: { audit: [], tick: null },
    resolvedBy: null,
  }
}

const RECORDS = [
  record('a', 'acme/widgets', 789, 'stale-snapshot:needsHuman:head-moved', '2026-11-16T12:00:00.000Z'),
  record('b', 'acme/widgets', 790, 'stale-snapshot:needsHuman:head-moved', '2026-11-16T12:00:05.000Z'),
  record('c', 'other/repo', 5, 'stale-snapshot:needsHuman:head-moved', '2026-11-16T12:01:00.000Z'),
  record('d', 'acme/widgets', 41, 'escalation:needsHuman:budget', '2026-11-16T12:02:00.000Z'),
]

const READ: IncidentRead = { ok: true, records: RECORDS, malformed: 1, pruned: { count: 3, through: '2026-01-01T00:00:00.000Z' }, readAt: 't' }

function depsWith(overrides: Partial<IncidentChannelDeps> = {}): IncidentChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] } as unknown as ReposListResponse),
    log: { read: () => Promise.resolve(READ) },
    chooseSavePath: () => Promise.resolve('/out/port-incidents.json'),
    writeJson: () => Promise.resolve({ ok: true, value: undefined }),
    now: () => new Date('2026-11-17T09:00:00.000Z'),
    ...overrides,
  }
}

describe('resolveIncidentGroups', () => {
  it('groups every repository for a null repoId and carries the read notes', async () => {
    const result = await resolveIncidentGroups(registryDeps, { repoId: null }, depsWith())
    expect(result).toMatchObject({ ok: true, malformed: 1, pruned: { count: 3 } })
    expect(result.ok && result.groups.map((group) => [group.signature, group.count])).toEqual([
      ['escalation:needsHuman:budget', 1],
      ['stale-snapshot:needsHuman:head-moved', 3],
    ])
  })

  it('scopes to the repository named by its own config, never by the request', async () => {
    const result = await resolveIncidentGroups(registryDeps, { repoId: REPO_ID }, depsWith())
    expect(result.ok && result.groups.find((group) => group.bucket === 'stale-snapshot')?.count).toBe(2)
  })

  it('passes a read failure through as a typed failure, never an empty list', async () => {
    const failure: IncidentRead = { ok: false, kind: 'permission-denied', message: 'EACCES', readAt: 't' }
    expect(await resolveIncidentGroups(registryDeps, { repoId: null }, depsWith({ log: { read: () => Promise.resolve(failure) } }))).toEqual(failure)
  })

  it('refuses a repoId that is not a registered ready repository', async () => {
    await expect(resolveIncidentGroups(registryDeps, { repoId: 'unknown' as unknown as RepoId }, depsWith())).rejects.toThrow()
  })
})

describe('resolveIncidentList', () => {
  it('returns one group\'s records newest first', async () => {
    const result = await resolveIncidentList(registryDeps, { repoId: null, signature: 'stale-snapshot:needsHuman:head-moved' }, depsWith())
    expect(result.ok && result.records.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
  })

  it.each(['', 'x'.repeat(200), 42])('throws on a malformed signature %s', async (signature) => {
    await expect(resolveIncidentList(registryDeps, { repoId: null, signature: signature as string }, depsWith())).rejects.toThrow("'incidents:list'")
  })
})

describe('resolveIncidentExport', () => {
  it('writes the grouped view where the operator chose', async () => {
    const writeJson = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
    const chooseSavePath = vi.fn(() => Promise.resolve('/out/port-incidents.json'))
    const result = await resolveIncidentExport(registryDeps, { repoId: REPO_ID }, depsWith({ writeJson, chooseSavePath }))
    expect(result).toEqual({ ok: true, path: '/out/port-incidents.json' })
    expect(chooseSavePath).toHaveBeenCalledWith('port-incidents-2026-11-17.json')
    expect(writeJson).toHaveBeenCalledWith('/out/port-incidents.json', expect.objectContaining({ v: 1, exportedAt: '2026-11-17T09:00:00.000Z', repo: 'acme/widgets', malformed: 1 }))
  })

  it('writes nothing and reports nothing on cancel', async () => {
    const writeJson = vi.fn()
    expect(await resolveIncidentExport(registryDeps, { repoId: null }, depsWith({ chooseSavePath: () => Promise.resolve(null), writeJson }))).toEqual({ ok: false, kind: 'cancelled' })
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('reports a failed write as an io failure', async () => {
    const result = await resolveIncidentExport(registryDeps, { repoId: null }, depsWith({ writeJson: () => Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }) }))
    expect(result).toEqual({ ok: false, kind: 'io', message: 'disk full' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { resolveStorageReport, resolveUsageSummary } from '@/main/channels/storage'
import type { StorageReportDeps } from '@/main/channels/storage'
import type { DirectorySizeResult } from '@/types/platform'
import type { RegistryDeps } from '@/types/registry'
import type { UsageLedger } from '@/types/settings'
import { readyEntry } from '../../../fixtures/board-state'

const registryDeps = {} as RegistryDeps

function depsWith(sizes: Readonly<Record<string, DirectorySizeResult>>): StorageReportDeps {
  const ready = readyEntry({ id: 'repo-a' as never, path: '/src/widgets' }, { repo: 'acme/widgets' })
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [ready] }),
    directorySize: (path) => Promise.resolve(sizes[path] ?? { ok: false, kind: 'io', message: `unexpected ${path}` }),
    userData: '/data',
    logs: '/data/logs',
    claudeHome: () => '/home/.claude',
  }
}

const OK = (bytes: number, truncated = false): DirectorySizeResult => ({ ok: true, bytes, entries: 1, truncated })

describe('resolveStorageReport', () => {
  it('reports app data, logs, the plugin cache and each ready repository’s worktrees', async () => {
    const report = await resolveStorageReport(
      registryDeps,
      undefined,
      depsWith({ '/data': OK(1), '/data/logs': OK(2), '/home/.claude/plugins/cache': OK(3), '/src/widgets/.claude/worktrees': OK(4, true) }),
    )
    expect(report.appData).toEqual([
      { label: 'App data', path: '/data', size: { ok: true, bytes: 1, truncated: false } },
      { label: 'Logs', path: '/data/logs', size: { ok: true, bytes: 2, truncated: false } },
    ])
    expect(report.pluginCache).toEqual({ label: 'Plugin cache', path: '/home/.claude/plugins/cache', size: { ok: true, bytes: 3, truncated: false } })
    expect(report.worktrees).toEqual([{ repoId: 'repo-a', label: 'acme/widgets', path: '/src/widgets/.claude/worktrees', size: { ok: true, bytes: 4, truncated: true } }])
  })

  it('keeps one failed read from blanking the others', async () => {
    const report = await resolveStorageReport(
      registryDeps,
      undefined,
      depsWith({ '/data': { ok: false, kind: 'io', message: 'EIO' }, '/data/logs': OK(2), '/home/.claude/plugins/cache': OK(3), '/src/widgets/.claude/worktrees': OK(4) }),
    )
    expect(report.appData[0]?.size).toEqual({ ok: false, message: 'EIO' })
    expect(report.appData[1]?.size).toMatchObject({ ok: true, bytes: 2 })
    expect(report.pluginCache.size).toMatchObject({ ok: true, bytes: 3 })
  })

  it('reads a directory that does not exist as empty, not as a failure', async () => {
    const missing: DirectorySizeResult = { ok: false, kind: 'not-found', message: 'ENOENT' }
    const report = await resolveStorageReport(registryDeps, undefined, depsWith({ '/data': OK(1), '/data/logs': OK(2), '/home/.claude/plugins/cache': missing, '/src/widgets/.claude/worktrees': missing }))
    expect(report.pluginCache.size).toEqual({ ok: true, bytes: 0, truncated: false })
    expect(report.worktrees[0]?.size).toEqual({ ok: true, bytes: 0, truncated: false })
  })

  it('still reports app data when the registry cannot be listed', async () => {
    const deps: StorageReportDeps = { ...depsWith({ '/data': OK(1), '/data/logs': OK(2), '/home/.claude/plugins/cache': OK(3) }), listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'x' }) }
    const report = await resolveStorageReport(registryDeps, undefined, deps)
    expect(report.worktrees).toEqual([])
    expect(report.appData).toHaveLength(2)
  })

  it('rejects a payload', async () => {
    await expect(resolveStorageReport(registryDeps, {} as never, depsWith({}))).rejects.toThrow("'storage:report' takes no payload")
  })
})

describe('resolveUsageSummary', () => {
  it('returns the ledger’s summary', () => {
    const summary = { rows: [], since: null }
    const ledger = { load: vi.fn(), observe: vi.fn(), summary: () => summary } as UsageLedger
    expect(resolveUsageSummary(undefined, ledger)).toBe(summary)
  })

  it('rejects a payload', () => {
    expect(() => resolveUsageSummary({} as never, { load: vi.fn(), observe: vi.fn(), summary: vi.fn() })).toThrow("'usage:summary' takes no payload")
  })
})

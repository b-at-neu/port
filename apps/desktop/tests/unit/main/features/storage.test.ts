import { describe, expect, it } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import type { DirectorySizeResult } from '@/types/platform'
import type { UsageLedger } from '@/types/settings'
import { callAction, createTestContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'

const REPO_PATH = '/src/widgets'
const DATA = '/test/userData'
const LOGS = '/test/logs'
const PLUGIN_CACHE = pathOps.join('/test/claude', 'plugins', 'cache')
const WORKTREES = pathOps.join(REPO_PATH, '.claude', 'worktrees')

function report(sizes: Readonly<Record<string, DirectorySizeResult>>, options: Parameters<typeof createTestContext>[0] = {}) {
  const ready = readyEntry({ id: 'repo-a' as never, path: REPO_PATH }, { repo: 'acme/widgets' })
  const directorySize = (path: string): Promise<DirectorySizeResult> => Promise.resolve(sizes[path] ?? { ok: false, kind: 'io', message: `unexpected ${path}` })
  return callAction(createTestContext({ repositories: [ready], ...options, platform: { directorySize } }), 'storage.report')
}

const OK = (bytes: number, truncated = false): DirectorySizeResult => ({ ok: true, bytes, entries: 1, truncated })

describe('storage.report', () => {
  it('reports app data, logs, the plugin cache and each ready repository’s worktrees', async () => {
    const result = await report({ [DATA]: OK(1), [LOGS]: OK(2), [PLUGIN_CACHE]: OK(3), [WORKTREES]: OK(4, true) })
    expect(result.appData).toEqual([
      { label: 'App data', path: DATA, size: { ok: true, bytes: 1, truncated: false } },
      { label: 'Logs', path: LOGS, size: { ok: true, bytes: 2, truncated: false } },
    ])
    expect(result.pluginCache).toEqual({ label: 'Plugin cache', path: PLUGIN_CACHE, size: { ok: true, bytes: 3, truncated: false } })
    expect(result.worktrees).toEqual([{ repoId: 'repo-a', label: 'acme/widgets', path: WORKTREES, size: { ok: true, bytes: 4, truncated: true } }])
  })

  it('keeps one failed read from blanking the others', async () => {
    const result = await report({ [DATA]: { ok: false, kind: 'io', message: 'EIO' }, [LOGS]: OK(2), [PLUGIN_CACHE]: OK(3), [WORKTREES]: OK(4) })
    expect(result.appData[0]?.size).toEqual({ ok: false, message: 'EIO' })
    expect(result.appData[1]?.size).toMatchObject({ ok: true, bytes: 2 })
    expect(result.pluginCache.size).toMatchObject({ ok: true, bytes: 3 })
  })

  it('reads a directory that does not exist as empty, not as a failure', async () => {
    const missing: DirectorySizeResult = { ok: false, kind: 'not-found', message: 'ENOENT' }
    const result = await report({ [DATA]: OK(1), [LOGS]: OK(2), [PLUGIN_CACHE]: missing, [WORKTREES]: missing })
    expect(result.pluginCache.size).toEqual({ ok: true, bytes: 0, truncated: false })
    expect(result.worktrees[0]?.size).toEqual({ ok: true, bytes: 0, truncated: false })
  })

  it('still reports app data when the registry cannot be listed', async () => {
    const result = await report({ [DATA]: OK(1), [LOGS]: OK(2), [PLUGIN_CACHE]: OK(3) }, { repos: { list: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'x' }) } })
    expect(result.worktrees).toEqual([])
    expect(result.appData).toHaveLength(2)
  })
})

describe('usage.summary', () => {
  it('returns the ledger’s summary', async () => {
    const summary = { rows: [], since: null }
    const usageLedger = { summary: () => summary } as unknown as UsageLedger
    const ctx = createTestContext({ stores: { usageLedger } })
    expect(await callAction(ctx, 'usage.summary')).toBe(summary)
  })
})

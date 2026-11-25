import { describe, expect, it } from 'vitest'
import { incidentsList } from '@/main/features/incidents/actions/list'
import type { IncidentRead, IncidentRecord } from '@/types/incidents'
import { callAction, createTestContext } from '../../../support/context'
import { createFakeClock, createFakeFs } from '../../../support/fake-platform'
import { readyEntry } from '../../../support/repo-config'

const entry = readyEntry({}, { repo: 'acme/widgets' })
const SIGNATURE = 'stale-snapshot:needsHuman:head-moved'

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

const READ: IncidentRead = {
  ok: true,
  records: [
    record('a', 'acme/widgets', 789, SIGNATURE, '2026-11-16T12:00:00.000Z'),
    record('b', 'acme/widgets', 790, SIGNATURE, '2026-11-16T12:00:05.000Z'),
    record('c', 'other/repo', 5, SIGNATURE, '2026-11-16T12:01:00.000Z'),
    record('d', 'acme/widgets', 41, 'escalation:needsHuman:budget', '2026-11-16T12:02:00.000Z'),
  ],
  malformed: 1,
  pruned: { count: 3, through: '2026-01-01T00:00:00.000Z' },
  readAt: 't',
}

function incidentsContext(options: { readonly read?: IncidentRead; readonly savePath?: string | null; readonly failWrite?: boolean } = {}) {
  const clock = createFakeClock('2026-11-17T09:00:00.000Z')
  const fs = createFakeFs(clock)
  const proposed: string[] = []
  const ctx = createTestContext({
    platform: {
      clock,
      fs: options.failWrite === true ? { ...fs, writeJsonAtomic: () => Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }) } : fs,
      dialogs: {
        chooseDirectory: () => Promise.resolve(null),
        chooseFolder: () => Promise.resolve(null),
        chooseSavePath: (name) => {
          proposed.push(name)
          return Promise.resolve(options.savePath === undefined ? '/out/port-incidents.json' : options.savePath)
        },
      },
    },
    repositories: [entry],
    stores: { incidentLog: { record: () => Promise.resolve(), read: () => Promise.resolve(options.read ?? READ) } },
  })
  return { ctx, fs, proposed }
}

describe('incidents.list input', () => {
  it.each([
    { signature: SIGNATURE, ok: true },
    { signature: '', ok: false },
    { signature: 'x'.repeat(199), ok: true },
    { signature: 'x'.repeat(200), ok: false },
  ])('signature of length $signature.length', ({ signature, ok }) => {
    expect(incidentsList.input.safeParse({ repoId: null, signature }).success).toBe(ok)
  })
})

describe('incidents actions', () => {
  it('groups every repository for a null repoId and carries the read notes', async () => {
    const result = await callAction(incidentsContext().ctx, 'incidents.groups', { repoId: null })
    expect(result).toMatchObject({ ok: true, malformed: 1, pruned: { count: 3 } })
    expect(result.ok && result.groups.map((group) => [group.signature, group.count])).toEqual([
      ['escalation:needsHuman:budget', 1],
      [SIGNATURE, 3],
    ])
  })

  it('scopes groups to the repository named by its own config', async () => {
    const result = await callAction(incidentsContext().ctx, 'incidents.groups', { repoId: entry.id })
    expect(result.ok && result.groups.find((group) => group.bucket === 'stale-snapshot')?.count).toBe(2)
  })

  it('passes a read failure through as a typed failure', async () => {
    const failure: IncidentRead = { ok: false, kind: 'permission-denied', message: 'EACCES', readAt: 't' }
    expect(await callAction(incidentsContext({ read: failure }).ctx, 'incidents.groups', { repoId: null })).toEqual(failure)
  })

  it('rejects a repository that is not registered', async () => {
    await expect(callAction(incidentsContext().ctx, 'incidents.groups', { repoId: 'unknown' as typeof entry.id })).rejects.toThrow("'incidents:groups' found no repository registered with id 'unknown'")
  })

  it('lists one group newest first', async () => {
    const result = await callAction(incidentsContext().ctx, 'incidents.list', { repoId: null, signature: SIGNATURE })
    expect(result.ok && result.records.map((found) => found.id)).toEqual(['c', 'b', 'a'])
  })

  it('exports the grouped view where the operator chose', async () => {
    const { ctx, fs, proposed } = incidentsContext()
    expect(await callAction(ctx, 'incidents.export', { repoId: entry.id })).toEqual({ ok: true, path: '/out/port-incidents.json' })
    expect(proposed).toEqual(['port-incidents-2026-11-17.json'])
    const written = await fs.readJson('/out/port-incidents.json')
    expect(written.ok && written.value).toMatchObject({ v: 1, exportedAt: '2026-11-17T09:00:00.000Z', repo: 'acme/widgets', malformed: 1 })
  })

  it('writes nothing on cancel', async () => {
    const { ctx, fs } = incidentsContext({ savePath: null })
    expect(await callAction(ctx, 'incidents.export', { repoId: null })).toEqual({ ok: false, kind: 'cancelled' })
    expect((await fs.readJson('/out/port-incidents.json')).ok).toBe(false)
  })

  it('reports a failed write as an io failure', async () => {
    expect(await callAction(incidentsContext({ failWrite: true }).ctx, 'incidents.export', { repoId: null })).toEqual({ ok: false, kind: 'io', message: 'disk full' })
  })
})

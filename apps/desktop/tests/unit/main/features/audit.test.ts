import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditList } from '@/main/features/audit/actions/list'
import { appendAudit } from '@/main/github/writes/audit'
import { isLabelAuditEntry, type LabelAuditEntry } from '@/types/writes'
import type { RepositoryEntry } from '@/utils/repos'
import { callAction, createTestContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'

const entry = readyEntry()

function labelEntry(repo: string, number: number): LabelAuditEntry {
  return { at: '2026-01-01T00:00:00.000Z', repo, repoId: entry.id, kind: 'issue', number, action: 'pause', ownership: { kind: 'absent' } as never, precondition: null, observed: null, call: null, commentBytes: null, result: { kind: 'applied' } as never }
}

async function seeded(repositories: readonly RepositoryEntry[] = [entry]) {
  const dir = await mkdtemp(join(tmpdir(), 'port-audit-'))
  for (const [repo, number] of [[entry.config.repo, 1], [entry.config.repo, 2], ['other/repo', 3]] as const) await appendAudit(dir, labelEntry(repo, number))
  return createTestContext({ platform: { paths: { userData: dir, temp: dir, logs: dir } }, repositories })
}

const numbersOf = (read: Awaited<ReturnType<typeof callAction<'audit.list'>>>) => (read.ok ? read.entries.filter(isLabelAuditEntry).map((audited) => audited.number).sort() : null)

describe('audit.list input', () => {
  it.each([
    { name: 'no repository and no number', input: { repoId: null, number: null }, ok: true },
    { name: 'a repository and a number', input: { repoId: entry.id, number: 2 }, ok: true },
    { name: 'a number without a repository', input: { repoId: null, number: 2 }, ok: false },
    { name: 'a non-positive number', input: { repoId: entry.id, number: 0 }, ok: false },
  ])('$name', ({ input, ok }) => {
    expect(auditList.input.safeParse(input).success).toBe(ok)
  })
})

describe('audit.list', () => {
  it('reads every repository for a null repoId', async () => {
    expect(numbersOf(await callAction(await seeded(), 'audit.list', { repoId: null, number: null }))).toEqual([1, 2, 3])
  })

  it('reads one repository', async () => {
    expect(numbersOf(await callAction(await seeded(), 'audit.list', { repoId: entry.id, number: null }))).toEqual([1, 2])
  })

  it('reads one item', async () => {
    expect(numbersOf(await callAction(await seeded(), 'audit.list', { repoId: entry.id, number: 2 }))).toEqual([2])
  })

  it('rejects a repository that is not ready', async () => {
    const ctx = await seeded([{ id: entry.id, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' }, diagnostics: [] }])
    await expect(callAction(ctx, 'audit.list', { repoId: entry.id, number: null })).rejects.toThrow("'audit:list' requires a 'ready' repository, got 'directory-missing'")
  })
})

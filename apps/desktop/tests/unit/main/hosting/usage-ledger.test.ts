import { describe, expect, it, vi } from 'vitest'
import { createUsageLedger, summarizeUsage } from '@/main/hosting/usage-ledger'
import type { FileResult } from '@/types/platform'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { UsageRecord } from '@/types/settings'
import type { RepoId } from '@/utils/repos'

const NOW = new Date(2026, 9, 30, 15, 0)
const REPO_A = 'repo-a' as RepoId
const REPO_B = 'repo-b' as RepoId

function at(daysAgo: number, hour = 12, minute = 0): string {
  return new Date(2026, 9, 30 - daysAgo, hour, minute).toISOString()
}

function record(id: string, repoId: RepoId | null, lastAt: string, costUsd: number | null, tokens: number | null): UsageRecord {
  return { id, repoId, lastAt, costUsd, tokens }
}

describe('summarizeUsage', () => {
  it('splits today, 7 days and 30 days on local calendar days', () => {
    const rows = summarizeUsage(
      [
        record('midnight', REPO_A, at(0, 0, 0), 1, 10),
        record('yesterday-late', REPO_A, at(1, 23, 59), 2, 20),
        record('six-days', REPO_A, at(6, 9), 4, 40),
        record('seven-days', REPO_A, at(7, 9), 8, 80),
      ],
      NOW,
    ).rows
    expect(rows).toEqual([
      {
        repoId: REPO_A,
        today: { costUsd: 1, totalTokens: 10, sessions: 1 },
        week: { costUsd: 7, totalTokens: 70, sessions: 3 },
        month: { costUsd: 15, totalTokens: 150, sessions: 4 },
      },
    ])
  })

  it('drops a record older than 30 days from every total', () => {
    const summary = summarizeUsage([record('old', REPO_A, at(30, 12), 5, 50), record('edge', REPO_A, at(29, 12), 3, 30)], NOW)
    expect(summary.rows[0]?.month).toEqual({ costUsd: 3, totalTokens: 30, sessions: 1 })
  })

  it('groups a null repository last, as its own row', () => {
    const rows = summarizeUsage([record('x', null, at(0), 1, 1), record('b', REPO_B, at(0), 1, 1), record('a', REPO_A, at(0), 1, 1)], NOW).rows
    expect(rows.map((row) => row.repoId)).toEqual([REPO_A, REPO_B, null])
  })

  it('keeps all-null readings null, never zero, while still counting the session', () => {
    const rows = summarizeUsage([record('x', REPO_A, at(0), null, null)], NOW).rows
    expect(rows[0]?.today).toEqual({ costUsd: null, totalTokens: null, sessions: 1 })
  })

  it('reports no rows and no start with no records', () => {
    expect(summarizeUsage([], NOW)).toEqual({ rows: [], since: null })
  })

  it('reports the oldest counted record as the start', () => {
    expect(summarizeUsage([record('a', REPO_A, at(2), 1, 1), record('b', REPO_A, at(5), 1, 1)], NOW).since).toBe(at(5))
  })
})

function snapshot(sessionKey: string, repoId: RepoId | null, costUsd: number | null, inputTokens: number | null): HostedSessionSnapshot {
  return { sessionKey, repoId, usage: { costUsd, inputTokens, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextTokens: null, contextWindow: null, observedAt: 'x' } } as unknown as HostedSessionSnapshot
}

interface Disk {
  file: unknown
  readonly writes: unknown[]
}

function ledgerOver(disk: Disk, bootId: string, now = NOW) {
  const gates: (() => void)[] = []
  const ledger = createUsageLedger({
    path: '/data/usage-ledger.json',
    readJson: <T>() => Promise.resolve((disk.file === undefined ? { ok: false, kind: 'not-found', message: 'missing' } : { ok: true, value: disk.file }) as FileResult<T>),
    writeJsonAtomic: (_path, value) =>
      new Promise((resolve) => {
        gates.push(() => {
          disk.writes.push(value)
          disk.file = value
          resolve({ ok: true, value: undefined })
        })
      }),
    now: () => now,
    bootId,
  })
  return { ledger, release: () => gates.shift()?.() }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createUsageLedger', () => {
  it('keys a record by boot id, so a restarted session key never collides', async () => {
    const disk: Disk = { file: undefined, writes: [] }
    const first = ledgerOver(disk, 'boot-1')
    first.ledger.observe(snapshot('hosted-1', REPO_A, 1, 100))
    first.release()
    await tick()
    const second = ledgerOver(disk, 'boot-2')
    await second.ledger.load()
    second.ledger.observe(snapshot('hosted-1', REPO_A, 2, 200))
    second.release()
    await tick()
    const ids = (disk.file as { records: UsageRecord[] }).records.map((r) => r.id).sort()
    expect(ids).toEqual(['boot-1:hosted-1', 'boot-2:hosted-1'])
    expect(second.ledger.summary().rows[0]?.today).toEqual({ costUsd: 3, totalTokens: 300, sessions: 2 })
  })

  it('writes nothing for an unchanged reading or a snapshot with no usage', async () => {
    const disk: Disk = { file: undefined, writes: [] }
    const { ledger, release } = ledgerOver(disk, 'b')
    ledger.observe(snapshot('hosted-1', REPO_A, 1, 100))
    release()
    await tick()
    ledger.observe(snapshot('hosted-1', REPO_A, 1, 100))
    ledger.observe({ sessionKey: 'hosted-2', repoId: REPO_A, usage: null } as unknown as HostedSessionSnapshot)
    release()
    await tick()
    expect(disk.writes).toHaveLength(1)
  })

  it('coalesces changes made during a write into one write of the newest state', async () => {
    const disk: Disk = { file: undefined, writes: [] }
    const { ledger, release } = ledgerOver(disk, 'b')
    ledger.observe(snapshot('hosted-1', REPO_A, 1, 100))
    ledger.observe(snapshot('hosted-1', REPO_A, 2, 200))
    ledger.observe(snapshot('hosted-1', REPO_A, 3, 300))
    release()
    await tick()
    release()
    await tick()
    expect(disk.writes).toHaveLength(2)
    expect((disk.writes[1] as { records: UsageRecord[] }).records[0]).toMatchObject({ costUsd: 3, tokens: 300 })
  })

  it('drops records older than 31 days on load', async () => {
    const disk: Disk = { file: { version: 1, records: [record('fresh', REPO_A, at(1), 1, 1), record('stale', REPO_A, at(32), 1, 1)] }, writes: [] }
    const { ledger } = ledgerOver(disk, 'b')
    await ledger.load()
    expect(ledger.summary().rows[0]?.month.sessions).toBe(1)
  })

  it.each([
    ['garbage', 'nope'],
    ['a newer version', { version: 2, records: [] }],
    ['a non-array records field', { version: 1, records: 'x' }],
  ])('loads empty from %s, logged once', async (_name, file) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ledger } = ledgerOver({ file, writes: [] }, 'b')
    await ledger.load()
    expect(ledger.summary()).toEqual({ rows: [], since: null })
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('drops malformed records one by one', async () => {
    const { ledger } = ledgerOver({ file: { version: 1, records: [record('ok', REPO_A, at(1), 1, 1), { id: 'bad' }, 7] }, writes: [] }, 'b')
    await ledger.load()
    expect(ledger.summary().rows[0]?.month.sessions).toBe(1)
  })
})

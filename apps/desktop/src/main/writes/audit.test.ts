import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { AuditEntry } from '../../shared/writes/types'
import { appendAudit, readAuditLog } from './audit'

const REPO_ID = 'repo-1' as unknown as RepoId

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: '2026-01-01T00:00:00Z',
    repo: 'o/r',
    repoId: REPO_ID,
    kind: 'issue',
    number: 1,
    action: 'test',
    scope: null,
    claim: 'not-required',
    precondition: null,
    observed: null,
    call: null,
    commentBytes: null,
    result: { kind: 'no-op' },
    ...overrides,
  }
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-writes-audit-'))
}

describe('appendAudit / readAuditLog', () => {
  it('appends one JSON line per call and reads it back', async () => {
    const dir = await makeTempDir()
    await appendAudit(dir, makeEntry({ number: 1 }))
    await appendAudit(dir, makeEntry({ number: 2 }))
    const read = await readAuditLog(dir)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.entries).toHaveLength(2)
    expect(read.entries.map((e) => e.number)).toEqual([1, 2])
    expect(read.malformed).toBe(0)
  })

  it('reports an empty, ok result for a log that does not exist yet', async () => {
    const dir = await makeTempDir()
    const read = await readAuditLog(dir)
    expect(read).toMatchObject({ ok: true, entries: [], malformed: 0, previousPath: null })
  })

  it('filters by repo and by number', async () => {
    const dir = await makeTempDir()
    await appendAudit(dir, makeEntry({ repo: 'o/r', number: 1 }))
    await appendAudit(dir, makeEntry({ repo: 'o/other', number: 1 }))
    await appendAudit(dir, makeEntry({ repo: 'o/r', number: 2 }))

    const byRepo = await readAuditLog(dir, { repo: 'o/r' })
    if (!byRepo.ok) throw new Error('unreachable')
    expect(byRepo.entries).toHaveLength(2)

    const byNumber = await readAuditLog(dir, { repo: 'o/r', number: 1 })
    if (!byNumber.ok) throw new Error('unreachable')
    expect(byNumber.entries).toHaveLength(1)
  })

  it('counts a malformed line rather than dropping it silently', async () => {
    const dir = await makeTempDir()
    await appendAudit(dir, makeEntry({ number: 1 }))
    await writeFile(join(dir, 'writes.jsonl'), 'not json at all\n', { flag: 'a' })
    const read = await readAuditLog(dir)
    if (!read.ok) throw new Error('unreachable')
    expect(read.entries).toHaveLength(1)
    expect(read.malformed).toBe(1)
  })

  it('rotates at the size threshold and reports previousPath', async () => {
    const dir = await makeTempDir()
    // Force rotation without waiting for 8 MB: write an oversized file
    // directly, then append once more through the real function.
    const bigLine = `${JSON.stringify(makeEntry({ number: 0 }))}\n`
    await writeFile(join(dir, 'writes.jsonl'), bigLine.repeat(1))
    await writeFile(join(dir, 'writes.jsonl'), 'x'.repeat(9 * 1024 * 1024))
    await appendAudit(dir, makeEntry({ number: 99 }))

    const prevContent = await readFile(join(dir, 'writes.prev.jsonl'), 'utf8')
    expect(prevContent.length).toBeGreaterThan(8 * 1024 * 1024)

    const read = await readAuditLog(dir)
    if (!read.ok) throw new Error('unreachable')
    expect(read.previousPath).toBe(join(dir, 'writes.prev.jsonl'))
  })

  it('caps entries at limit, keeping the newest', async () => {
    const dir = await makeTempDir()
    for (let i = 0; i < 5; i++) {
      await appendAudit(dir, makeEntry({ number: i }))
    }
    const read = await readAuditLog(dir, { limit: 2 })
    if (!read.ok) throw new Error('unreachable')
    expect(read.entries.map((e) => e.number)).toEqual([3, 4])
  })
})

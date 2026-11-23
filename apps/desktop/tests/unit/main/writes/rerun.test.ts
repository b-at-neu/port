import { describe, expect, it, vi } from 'vitest'
import { rerunFailedJobs } from '@/main/github/writes/rerun'
import type { GhResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ID = 'repo-a' as RepoId

async function auditDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-rerun-'))
}

async function entries(dir: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(join(dir, 'writes.jsonl'), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('rerunFailedJobs', () => {
  it('re-runs only the failed jobs of the named run and audits one applied entry', async () => {
    const dir = await auditDir()
    const gh = vi.fn((argv: readonly string[]) => {
      void argv
      return Promise.resolve({ ok: true, stdout: '', stderr: '' } as unknown as GhResult)
    })
    const result = await rerunFailedJobs({ repo: 'o/a', repoId: REPO_ID, auditDir: dir, gh, now: () => new Date('2026-01-01T00:00:00Z') }, { number: 780, runId: '777', check: 'run-e2e' })
    expect(result).toEqual({ kind: 'applied' })
    expect(gh).toHaveBeenCalledWith(['run', 'rerun', '777', '--failed', '--repo', 'o/a'])
    expect(await entries(dir)).toEqual([
      { at: '2026-01-01T00:00:00.000Z', repo: 'o/a', repoId: REPO_ID, action: 'observe-rerun-checks', number: 780, check: 'run-e2e', runId: '777', call: ['run', 'rerun', '777', '--failed', '--repo', 'o/a'], result: 'applied', failure: null },
    ])
  })

  it('reports a failed re-run and audits it, never throwing', async () => {
    const dir = await auditDir()
    const gh = () => Promise.resolve({ ok: false, kind: 'failed', stderr: 'run 777 cannot be rerun', stdout: '', exitCode: 1 } as unknown as GhResult)
    const result = await rerunFailedJobs({ repo: 'o/a', repoId: REPO_ID, auditDir: dir, gh }, { number: 780, runId: '777', check: 'run-e2e' })
    expect(result.kind).toBe('write-failed')
    const [entry] = await entries(dir)
    expect(entry).toMatchObject({ result: 'failed', action: 'observe-rerun-checks' })
    expect(typeof entry?.failure).toBe('string')
  })
})

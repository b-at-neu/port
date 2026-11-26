import { describe, expect, it } from 'vitest'
import { rerunFailedJobs } from '@/main/github/writes/rerun'
import type { GhResult, GhRunner } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeClock, createFakePlatform } from '../../../../support/fake-platform'

const REPO_ID = 'repo-a' as RepoId
const PARAMS = { number: 780, runId: '777', check: 'run-e2e' }

async function run(result: GhResult) {
  const dir = await mkdtemp(join(tmpdir(), 'port-rerun-'))
  const calls: (readonly string[])[] = []
  const ghWrite: GhRunner = (argv) => {
    calls.push(argv)
    return Promise.resolve(result)
  }
  const ctx = { ...createFakePlatform(), ghWrite, clock: createFakeClock('2026-01-01T00:00:00Z') }
  const outcome = await rerunFailedJobs(ctx, { repo: 'o/a', repoId: REPO_ID, auditDir: dir }, PARAMS)
  const entries = (await readFile(join(dir, 'writes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  return { outcome, calls, entries }
}

describe('rerunFailedJobs', () => {
  it('re-runs only the failed jobs of the named run and audits one applied entry', async () => {
    const { outcome, calls, entries } = await run({ ok: true, stdout: '', stderr: '' })
    expect(outcome).toEqual({ kind: 'applied' })
    expect(calls).toEqual([['run', 'rerun', '777', '--failed', '--repo', 'o/a']])
    expect(entries).toEqual([
      { at: '2026-01-01T00:00:00.000Z', repo: 'o/a', repoId: REPO_ID, action: 'observe-rerun-checks', number: 780, check: 'run-e2e', runId: '777', call: calls[0], result: 'applied', failure: null },
    ])
  })

  it('reports a failed re-run and audits it, never throwing', async () => {
    const { outcome, entries } = await run({ ok: false, kind: 'unknown', stderr: 'run 777 cannot be rerun', stdout: '' })
    expect(outcome).toEqual({ kind: 'write-failed', message: 'run 777 cannot be rerun' })
    expect(entries[0]).toMatchObject({ result: 'failed', action: 'observe-rerun-checks', failure: 'run 777 cannot be rerun' })
  })
})

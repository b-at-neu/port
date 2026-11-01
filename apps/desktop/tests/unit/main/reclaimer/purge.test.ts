import { describe, expect, it } from 'vitest'
import { createPathOps } from '@/main/platform/paths'
import type { CommandResult, NodeRunner } from '@/types/platform'
import { SCRIPT_FAIL_PREFIX } from '@/main/reclaimer/report'
import { runPurge } from '@/main/reclaimer/purge'

const posixPathOps = createPathOps('posix', { home: '/home/op' })
const PATH = '/repo/.claude/worktrees/impl-29-stale'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(stdout: string, stderr: string, code = 2): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout, stderr }
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ mainRoot: '/repo', results: [{ path: PATH, deleted: true, refused: null, error: null, cause: null, ...overrides }] })
}

function params(runNode: NodeRunner, worktreesCommand: string | null = 'node w.mjs') {
  return { repoRoot: '/repo', worktreesCommand, path: PATH, runNode, pathOps: posixPathOps }
}

describe('runPurge', () => {
  it('reports not-configured without spawning anything', async () => {
    let called = false
    const result = await runPurge(
      params(() => {
        called = true
        return Promise.resolve(ok(''))
      }, null),
    )
    expect(called).toBe(false)
    expect(result).toMatchObject({ ok: false, kind: 'not-configured', call: null })
  })

  it('reports an unsupported runner without spawning anything', async () => {
    let called = false
    const result = await runPurge(
      params(() => {
        called = true
        return Promise.resolve(ok(''))
      }, 'pnpm run wt'),
    )
    expect(called).toBe(false)
    expect(result).toMatchObject({ ok: false, kind: 'unsupported-runner', token: 'pnpm' })
  })

  it('drives purge --orphan <path> --json for exactly that path', async () => {
    let seenArgs: readonly string[] = []
    const result = await runPurge(
      params((args) => {
        seenArgs = args
        return Promise.resolve(ok(payload()))
      }),
    )
    expect(seenArgs).toEqual(['w.mjs', 'purge', '--orphan', PATH, '--json'])
    expect(result).toMatchObject({ ok: true, outcome: 'deleted', pathBasename: 'impl-29-stale', call: seenArgs })
  })

  it('an exit-2 refusal with parseable stdout is an ok result carrying the script’s own words', async () => {
    const result = await runPurge(params(() => Promise.resolve(nonzero(payload({ deleted: false, refused: 'never deleted' }), ''))))
    expect(result).toMatchObject({ ok: true, outcome: 'refused', message: 'never deleted' })
  })

  it('an exit-2 failure carries its cause', async () => {
    const result = await runPurge(params(() => Promise.resolve(nonzero(payload({ deleted: false, error: 'EBUSY', cause: 'file-in-use' }), ''))))
    expect(result).toMatchObject({ ok: true, outcome: 'failed', message: 'EBUSY', cause: 'file-in-use' })
  })

  it('a FAIL stderr with no parseable stdout becomes script-failed', async () => {
    const result = await runPurge(params(() => Promise.resolve(nonzero('', `${SCRIPT_FAIL_PREFIX}not a git repository`, 1))))
    expect(result).toMatchObject({ ok: false, kind: 'script-failed', message: `${SCRIPT_FAIL_PREFIX}not a git repository` })
  })

  it('maps a timeout straight through, never retried', async () => {
    let calls = 0
    const result = await runPurge(
      params(() => {
        calls++
        return Promise.resolve({ ok: false, kind: 'timeout', timeoutMs: 60_000, stderr: '' })
      }),
    )
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    expect(calls).toBe(1)
  })

  it('a malformed payload on a clean exit is report-unparseable', async () => {
    const result = await runPurge(params(() => Promise.resolve(ok('not json'))))
    expect(result).toMatchObject({ ok: false, kind: 'report-unparseable' })
  })
})

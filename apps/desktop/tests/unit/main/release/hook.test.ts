import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { runPostPublishHook } from '@/main/features/release/hook'

interface Seen {
  command?: string
  args?: readonly string[]
  cwd?: string | undefined
  timeoutMs?: number | undefined
}

function ctxWith(result: CommandResult, seen: Seen = {}) {
  return {
    run: (command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      seen.command = command
      seen.args = args
      seen.cwd = options?.cwd
      seen.timeoutMs = options?.timeoutMs
      return Promise.resolve(result)
    },
  }
}

const neverRuns = { run: () => Promise.reject(new Error('must not run')) }

describe('runPostPublishHook', () => {
  it('skips a null hook without running anything', async () => {
    expect(await runPostPublishHook(neverRuns, { command: null, cwd: '/repo' })).toEqual({ kind: 'skipped' })
  })

  it('runs the node command once in the repository with a five minute timeout', async () => {
    const seen: Seen = {}
    const outcome = await runPostPublishHook(ctxWith({ ok: true, stdout: 'opened', stderr: '' }, seen), { command: 'node scripts/dev-window.ts', cwd: '/repo' })
    expect(outcome).toEqual({ kind: 'ok', stdout: 'opened' })
    expect(seen).toEqual({ command: 'node', args: ['scripts/dev-window.ts'], cwd: '/repo', timeoutMs: 300_000 })
  })

  it('reports a non-zero exit with its code and stderr', async () => {
    const outcome = await runPostPublishHook(ctxWith({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: 'dirty tree' }), { command: 'node scripts/dev-window.ts', cwd: '/repo' })
    expect(outcome).toEqual({ kind: 'failed', exitCode: 1, stderr: 'dirty tree' })
  })

  it('reports anything that is not node as unrunnable, never spawning it', async () => {
    expect((await runPostPublishHook(neverRuns, { command: 'bash release.sh', cwd: '/repo' })).kind).toBe('unrunnable')
    expect((await runPostPublishHook(neverRuns, { command: 'node a.js | tee out', cwd: '/repo' })).kind).toBe('unrunnable')
  })

  it('reports a missing node as unrunnable and a timeout as a failure without an exit code', async () => {
    expect((await runPostPublishHook(ctxWith({ ok: false, kind: 'not-found', command: 'node', searched: [] }), { command: 'node x.js', cwd: '/repo' })).kind).toBe('unrunnable')
    expect(await runPostPublishHook(ctxWith({ ok: false, kind: 'timeout', timeoutMs: 300_000, stderr: 'slow' }), { command: 'node x.js', cwd: '/repo' })).toEqual({ kind: 'failed', exitCode: null, stderr: 'slow' })
  })
})

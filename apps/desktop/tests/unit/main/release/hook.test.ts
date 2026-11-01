import { describe, expect, it } from 'vitest'
import type { CommandResult, NodeRunner } from '@/types/platform'
import { runPostPublishHook } from '@/main/release/hook'

function runner(result: CommandResult, seen: { args?: readonly string[]; cwd?: string | undefined; timeoutMs?: number | undefined } = {}): NodeRunner {
  return (args, options) => {
    seen.args = args
    seen.cwd = options.cwd
    seen.timeoutMs = options.timeoutMs
    return Promise.resolve(result)
  }
}

describe('runPostPublishHook', () => {
  it('skips a null hook without running anything', async () => {
    const outcome = await runPostPublishHook({ command: null, cwd: '/repo', runNode: () => Promise.reject(new Error('must not run')) })
    expect(outcome).toEqual({ kind: 'skipped' })
  })

  it('runs the node command once in the repository with a five minute timeout', async () => {
    const seen: { args?: readonly string[]; cwd?: string | undefined; timeoutMs?: number | undefined } = {}
    const outcome = await runPostPublishHook({ command: 'node scripts/dev-window.ts', cwd: '/repo', runNode: runner({ ok: true, stdout: 'opened', stderr: '' }, seen) })
    expect(outcome).toEqual({ kind: 'ok', stdout: 'opened' })
    expect(seen).toEqual({ args: ['scripts/dev-window.ts'], cwd: '/repo', timeoutMs: 300_000 })
  })

  it('reports a non-zero exit with its code and stderr', async () => {
    const outcome = await runPostPublishHook({ command: 'node scripts/dev-window.ts', cwd: '/repo', runNode: runner({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: 'dirty tree' }) })
    expect(outcome).toEqual({ kind: 'failed', exitCode: 1, stderr: 'dirty tree' })
  })

  it('reports anything that is not node as unrunnable, never spawning it', async () => {
    const outcome = await runPostPublishHook({ command: 'bash release.sh', cwd: '/repo', runNode: () => Promise.reject(new Error('must not run')) })
    expect(outcome.kind).toBe('unrunnable')
    const piped = await runPostPublishHook({ command: 'node a.js | tee out', cwd: '/repo', runNode: () => Promise.reject(new Error('must not run')) })
    expect(piped.kind).toBe('unrunnable')
  })

  it('reports a missing node as unrunnable and a timeout as a failure without an exit code', async () => {
    expect((await runPostPublishHook({ command: 'node x.js', cwd: '/repo', runNode: runner({ ok: false, kind: 'not-found', command: 'node', searched: [] }) })).kind).toBe('unrunnable')
    expect(await runPostPublishHook({ command: 'node x.js', cwd: '/repo', runNode: runner({ ok: false, kind: 'timeout', timeoutMs: 300_000, stderr: 'slow' }) })).toEqual({ kind: 'failed', exitCode: null, stderr: 'slow' })
  })
})

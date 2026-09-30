import { describe, expect, it } from 'vitest'
import { runCommand, runExecutable } from './run'
import type { Spawner } from './run'

function rejecting(failure: Record<string, unknown>): Spawner {
  return () => Promise.reject(Object.assign(new Error('spawn failed'), failure))
}

describe('runExecutable — classification table (fake spawner)', () => {
  it('maps ENOENT to not-found', async () => {
    const result = await runExecutable('/no/such/binary', [], { spawner: rejecting({ code: 'ENOENT' }) })
    expect(result).toEqual({ ok: false, kind: 'not-found', command: '/no/such/binary', searched: ['/no/such/binary'] })
  })

  it('maps a numeric exit code to nonzero, carrying stdout/stderr', async () => {
    const result = await runExecutable('/bin/x', [], {
      spawner: rejecting({ code: 128, stdout: 'partial', stderr: 'bad ref' }),
    })
    expect(result).toEqual({ ok: false, kind: 'nonzero', code: 128, stdout: 'partial', stderr: 'bad ref' })
  })

  it('maps a signal to signalled', async () => {
    const result = await runExecutable('/bin/x', [], { spawner: rejecting({ signal: 'SIGTERM', stderr: 'killed' }) })
    expect(result).toEqual({ ok: false, kind: 'signalled', signal: 'SIGTERM', stderr: 'killed' })
  })

  it('maps killed:true to timeout, ahead of any exit code', async () => {
    const result = await runExecutable('/bin/x', [], {
      timeoutMs: 5_000,
      spawner: rejecting({ killed: true, code: 'SIGTERM', stderr: 'took too long' }),
    })
    expect(result).toEqual({ ok: false, kind: 'timeout', timeoutMs: 5_000, stderr: 'took too long' })
  })

  it('maps ERR_CHILD_PROCESS_STDIO_MAXBUFFER to output-too-large, with no partial stdout', async () => {
    const result = await runExecutable('/bin/x', [], {
      maxBytes: 1024,
      spawner: rejecting({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'should not appear' }),
    })
    expect(result).toEqual({ ok: false, kind: 'output-too-large', maxBytes: 1024 })
  })

  it('falls back to spawn-failed for anything else', async () => {
    const spawner: Spawner = () => Promise.reject(new Error('permission denied'))
    const result = await runExecutable('/bin/x', [], { spawner })
    expect(result).toEqual({ ok: false, kind: 'spawn-failed', message: 'permission denied' })
  })

  it('returns ok:true with stdout/stderr on success', async () => {
    const spawner: Spawner = () => Promise.resolve({ stdout: 'hi', stderr: '' })
    const result = await runExecutable('/bin/x', ['--version'], { spawner })
    expect(result).toEqual({ ok: true, stdout: 'hi', stderr: '' })
  })
})

describe('runExecutable — real process, no git or gh required', () => {
  it('captures stdout from a real child process', async () => {
    const result = await runExecutable(process.execPath, ['-e', "process.stdout.write('hello')"])
    expect(result).toEqual({ ok: true, stdout: 'hello', stderr: '' })
  })

  it('captures stderr and a nonzero exit code', async () => {
    const result = await runExecutable(process.execPath, ['-e', "process.stderr.write('oops'); process.exit(3)"])
    expect(result).toEqual({ ok: false, kind: 'nonzero', code: 3, stdout: '', stderr: 'oops' })
  })

  it('times out a long-running process', async () => {
    const result = await runExecutable(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('timeout')
  }, 10_000)

  it('reports output-too-large on an oversized write', async () => {
    const result = await runExecutable(process.execPath, ["-e", "process.stdout.write('x'.repeat(1_000_000))"], {
      maxBytes: 1024,
    })
    expect(result).toEqual({ ok: false, kind: 'output-too-large', maxBytes: 1024 })
  })
})

describe('runCommand', () => {
  it('reports cwd-missing before attempting resolution', async () => {
    const result = await runCommand('git', [], { cwd: '/definitely/not/a/real/path/xyz' })
    expect(result).toEqual({ ok: false, kind: 'cwd-missing', cwd: '/definitely/not/a/real/path/xyz' })
  })

  it('surfaces a resolution failure as not-found, never spawning', async () => {
    let spawnerCalled = false
    const result = await runCommand('git', [], {
      whichEnv: { PATH: '' },
      resolve: () => Promise.resolve({ ok: false, kind: 'not-found', command: 'git', searched: ['/dev/null/git'] }),
      spawner: () => {
        spawnerCalled = true
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    })
    expect(result).toEqual({ ok: false, kind: 'not-found', command: 'git', searched: ['/dev/null/git'] })
    expect(spawnerCalled).toBe(false)
  })

  it('resolves then spawns the resolved absolute path', async () => {
    const result = await runCommand('git', ['status'], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/git' }),
      spawner: (absPath, args) => {
        expect(absPath).toBe('/usr/bin/git')
        expect(args).toEqual(['status'])
        return Promise.resolve({ stdout: 'clean', stderr: '' })
      },
    })
    expect(result).toEqual({ ok: true, stdout: 'clean', stderr: '' })
  })

  it('resolves and spawns a node invocation the same way as git/gh (#86)', async () => {
    const result = await runCommand('node', ['worktrees.mjs', 'report', '--json'], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/node' }),
      spawner: (absPath, args) => {
        expect(absPath).toBe('/usr/bin/node')
        expect(args).toEqual(['worktrees.mjs', 'report', '--json'])
        return Promise.resolve({ stdout: '{}', stderr: '' })
      },
    })
    expect(result).toEqual({ ok: true, stdout: '{}', stderr: '' })
  })
})

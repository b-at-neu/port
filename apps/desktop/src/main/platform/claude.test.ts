import { describe, expect, it } from 'vitest'
import { claude } from './claude'

describe('claude', () => {
  it('resolves and spawns through runCommand, the same seam as git/gh/node', async () => {
    const result = await claude(['--version'], {
      resolve: () => Promise.resolve({ ok: true, path: '/home/operator/.local/bin/claude' }),
      spawner: (absPath, args) => {
        expect(absPath).toBe('/home/operator/.local/bin/claude')
        expect(args).toEqual(['--version'])
        return Promise.resolve({ stdout: '2.1.0 (Claude Code)\n', stderr: '' })
      },
    })
    expect(result).toEqual({ ok: true, stdout: '2.1.0 (Claude Code)\n', stderr: '' })
  })

  it('defaults timeoutMs to 10s, above the platform layer default but well under node/gh', async () => {
    let seenTimeout: number | undefined
    const result = await claude([], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/claude' }),
      spawner: (_absPath, _args, params) => {
        seenTimeout = params.timeout
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    })
    expect(result.ok).toBe(true)
    expect(seenTimeout).toBe(10_000)
  })

  it('an explicit timeoutMs overrides the 10s default', async () => {
    let seenTimeout: number | undefined
    await claude([], {
      timeoutMs: 2_000,
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/claude' }),
      spawner: (_absPath, _args, params) => {
        seenTimeout = params.timeout
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    })
    expect(seenTimeout).toBe(2_000)
  })

  it('surfaces a not-found resolution the same as any other known command', async () => {
    const result = await claude([], {
      resolve: () => Promise.resolve({ ok: false, kind: 'not-found', command: 'claude', searched: ['/usr/bin/claude'] }),
    })
    expect(result).toEqual({ ok: false, kind: 'not-found', command: 'claude', searched: ['/usr/bin/claude'] })
  })
})

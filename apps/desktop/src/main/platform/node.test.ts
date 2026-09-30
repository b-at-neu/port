import { describe, expect, it } from 'vitest'
import { node } from './node'

describe('node', () => {
  it('resolves and spawns through runCommand, the same seam as git/gh', async () => {
    const result = await node(['worktrees.mjs', 'report', '--json'], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/node' }),
      spawner: (absPath, args) => {
        expect(absPath).toBe('/usr/bin/node')
        expect(args).toEqual(['worktrees.mjs', 'report', '--json'])
        return Promise.resolve({ stdout: '{}', stderr: '' })
      },
    })
    expect(result).toEqual({ ok: true, stdout: '{}', stderr: '' })
  })

  it('defaults timeoutMs to 60s, above the platform layer default', async () => {
    let seenTimeout: number | undefined
    const result = await node([], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/node' }),
      spawner: (_absPath, _args, params) => {
        seenTimeout = params.timeout
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    })
    expect(result.ok).toBe(true)
    expect(seenTimeout).toBe(60_000)
  })

  it('an explicit timeoutMs overrides the 60s default', async () => {
    let seenTimeout: number | undefined
    await node([], {
      timeoutMs: 5_000,
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/node' }),
      spawner: (_absPath, _args, params) => {
        seenTimeout = params.timeout
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    })
    expect(seenTimeout).toBe(5_000)
  })

  it('surfaces a not-found resolution the same as any other known command', async () => {
    const result = await node([], {
      resolve: () => Promise.resolve({ ok: false, kind: 'not-found', command: 'node', searched: ['/usr/bin/node'] }),
    })
    expect(result).toEqual({ ok: false, kind: 'not-found', command: 'node', searched: ['/usr/bin/node'] })
  })
})

import { describe, expect, it } from 'vitest'
import { node } from '@/main/platform/node'

describe('node', () => {
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
})

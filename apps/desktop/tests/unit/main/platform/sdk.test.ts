import { describe, expect, it } from 'vitest'
import { createSdk, type SdkModule } from '@/main/platform/sdk'

function fakeModule(): SdkModule {
  return {
    query: () => {
      throw new Error('not called')
    },
    renameSession: () => Promise.resolve(undefined),
    listSessions: () => Promise.resolve([]),
  }
}

describe('createSdk — no SDK ever loaded', () => {
  it('resolves the injected fake, never the real package', async () => {
    const fake = fakeModule()
    const sdk = createSdk(() => Promise.resolve(fake))
    expect(await sdk.load()).toBe(fake)
  })

  it('a rejected import surfaces to the caller rather than being swallowed', async () => {
    const sdk = createSdk(() => Promise.reject(new Error('module not found')))
    await expect(sdk.load()).rejects.toThrow('module not found')
  })

  it('a later successful call is not wedged behind an earlier rejection', async () => {
    let attempt = 0
    const sdk = createSdk(() => {
      attempt += 1
      if (attempt === 1) return Promise.reject(new Error('transient'))
      return Promise.resolve(fakeModule())
    })
    await expect(sdk.load()).rejects.toThrow('transient')
    await expect(sdk.load()).resolves.toBeDefined()
  })
})

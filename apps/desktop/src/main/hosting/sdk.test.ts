import { describe, expect, it } from 'vitest'
import { createHostedSdk } from './sdk'

describe('createHostedSdk — no SDK ever loaded', () => {
  it('resolves the injected fake, never the real package', async () => {
    const fakeQuery = (): never => {
      throw new Error('not called')
    }
    const fakeRename = (): Promise<void> => Promise.resolve(undefined)
    const getSdk = createHostedSdk(() => Promise.resolve({ query: fakeQuery, renameSession: fakeRename }))
    const sdk = await getSdk()
    expect(sdk.query).toBe(fakeQuery)
    expect(sdk.renameSession).toBe(fakeRename)
  })

  it('a rejected import surfaces to the caller rather than being swallowed', async () => {
    const getSdk = createHostedSdk(() => Promise.reject(new Error('module not found')))
    await expect(getSdk()).rejects.toThrow('module not found')
  })

  it('a later successful call is not wedged behind an earlier rejection', async () => {
    let attempt = 0
    const getSdk = createHostedSdk(() => {
      attempt += 1
      if (attempt === 1) return Promise.reject(new Error('transient'))
      return Promise.resolve({
        query: () => {
          throw new Error('unused')
        },
        renameSession: () => Promise.resolve(undefined),
      })
    })
    await expect(getSdk()).rejects.toThrow('transient')
    await expect(getSdk()).resolves.toBeDefined()
  })
})

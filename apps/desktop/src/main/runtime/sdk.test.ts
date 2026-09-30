import { describe, expect, it } from 'vitest'
import { createRuntimeProbe } from './sdk'

/** Mirrors `sdk.ts`'s own (unexported) `ProbeMessage` shape — every real
 *  `SDKMessage` variant satisfies it too, so this fixture stays faithful to
 *  what the real stream actually carries without pulling in every required
 *  field of the real `SDKResultMessage` union. */
interface FakeMessage {
  readonly type: string
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
}

async function* messages(...items: readonly FakeMessage[]): AsyncGenerator<FakeMessage> {
  await Promise.resolve()
  for (const item of items) yield item
}

const BASE_PARAMS = { executablePath: '/home/operator/.local/bin/claude', cwd: '/repo', credentials: null, now: 1000 }

describe('createRuntimeProbe — no SDK ever loaded', () => {
  it('a successful, non-error result is verified', async () => {
    const probe = createRuntimeProbe(() =>
      Promise.resolve({ query: () => messages({ type: 'assistant' }, { type: 'result', subtype: 'success', is_error: false, result: 'ok' }) }),
    )
    const outcome = await probe(BASE_PARAMS)
    expect(outcome).toEqual({ diagnosis: 'verified', detail: null })
  })

  it('a success result with is_error true is classified from its result text, not reported verified', async () => {
    const probe = createRuntimeProbe(() =>
      Promise.resolve({ query: () => messages({ type: 'result', subtype: 'success', is_error: true, result: 'not logged in' }) }),
    )
    const outcome = await probe(BASE_PARAMS)
    expect(outcome).toEqual({ diagnosis: 'unauthenticated', detail: 'not logged in' })
  })

  it('an error-subtype result is classified from its joined errors', async () => {
    const probe = createRuntimeProbe(() =>
      Promise.resolve({ query: () => messages({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['stopped: max turns reached'] }) }),
    )
    const outcome = await probe(BASE_PARAMS)
    expect(outcome).toEqual({ diagnosis: 'probe-failed', detail: 'stopped: max turns reached' })
  })

  it('a stream with no result message at all is probe-failed, never an open await', async () => {
    const probe = createRuntimeProbe(() => Promise.resolve({ query: () => messages({ type: 'assistant' }, { type: 'system' }) }))
    const outcome = await probe(BASE_PARAMS)
    expect(outcome.diagnosis).toBe('probe-failed')
  })

  it('a rejected import() is probe-failed, never a throw', async () => {
    const probe = createRuntimeProbe(() => Promise.reject(new Error('module not found')))
    const outcome = await probe(BASE_PARAMS)
    expect(outcome).toEqual({ diagnosis: 'probe-failed', detail: 'module not found' })
  })

  it('query() throwing synchronously is probe-failed, never a throw out of the probe', async () => {
    const probe = createRuntimeProbe(() =>
      Promise.resolve({
        query: () => {
          throw new Error('spawn failed')
        },
      }),
    )
    const outcome = await probe(BASE_PARAMS)
    expect(outcome).toEqual({ diagnosis: 'probe-failed', detail: 'spawn failed' })
  })

  it('the credentials tell still wins inside a probe failure classification', async () => {
    const probe = createRuntimeProbe(() =>
      Promise.resolve({ query: () => messages({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['connection reset'] }) }),
    )
    const outcome = await probe({ ...BASE_PARAMS, credentials: { present: true, expiresAt: 0, hasRefreshToken: true } })
    expect(outcome.diagnosis).toBe('token-stale')
  })
})

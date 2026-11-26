import { describe, expect, it } from 'vitest'
import { runProbe } from '@/main/sessions/runtime/probe'
import type { Platform } from '@/main/platform'
import type { HostedQueryFn } from '@/main/platform/sdk'
import { fakeSdk } from '../../../../support/fake-platform'

/** Mirrors the probe's own message shape, so this fixture stays faithful without pulling in every field of the real `SDKResultMessage` union. */
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

function sdkOf(query: () => AsyncIterable<FakeMessage>): Pick<Platform, 'sdk'> {
  return { sdk: fakeSdk({ query: query as unknown as HostedQueryFn }) }
}

const BASE_PARAMS = { executablePath: '/home/operator/.local/bin/claude', cwd: '/repo' }

describe('runProbe — no SDK ever loaded', () => {
  it.each([
    { name: 'a successful, non-error result is verified', stream: [{ type: 'assistant' }, { type: 'result', subtype: 'success', is_error: false, result: 'ok' }], expected: { diagnosis: 'verified', detail: null } },
    {
      name: 'a success result with is_error true is classified from its result text, not reported verified',
      stream: [{ type: 'result', subtype: 'success', is_error: true, result: 'not logged in' }],
      expected: { diagnosis: 'unauthenticated', detail: 'not logged in' },
    },
    {
      name: 'an error-subtype result is classified from its joined errors',
      stream: [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['stopped: max turns reached'] }],
      expected: { diagnosis: 'probe-failed', detail: 'stopped: max turns reached' },
    },
    { name: 'a stream with no result message at all is probe-failed, never an open await', stream: [{ type: 'assistant' }, { type: 'system' }], expected: { diagnosis: 'probe-failed' } },
    {
      name: 'a result whose errors name a failed token refresh is token-stale',
      stream: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Failed to refresh OAuth token'] }],
      expected: { diagnosis: 'token-stale' },
    },
    {
      name: 'an unrelated error is probe-failed, never token-stale',
      stream: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['connection reset'] }],
      expected: { diagnosis: 'probe-failed' },
    },
  ] satisfies { name: string; stream: FakeMessage[]; expected: object }[])('$name', async ({ stream, expected }) => {
    await expect(runProbe(sdkOf(() => messages(...stream)), BASE_PARAMS)).resolves.toMatchObject(expected)
  })

  it('a rejected import() is probe-failed, never a throw', async () => {
    const outcome = await runProbe({ sdk: { load: () => Promise.reject(new Error('module not found')) } }, BASE_PARAMS)
    expect(outcome).toEqual({ diagnosis: 'probe-failed', detail: 'module not found' })
  })

  it('query() throwing synchronously is probe-failed, never a throw out of the probe', async () => {
    const outcome = await runProbe(
      sdkOf(() => {
        throw new Error('spawn failed')
      }),
      BASE_PARAMS,
    )
    expect(outcome).toEqual({ diagnosis: 'probe-failed', detail: 'spawn failed' })
  })
})

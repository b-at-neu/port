import { describe, expect, it } from 'vitest'
import { resolveGhStatus } from './gh'
import type { GhStatusDeps } from './gh'
import type { GhAuthStatusResult } from '../platform/gh'

function depsWith(result: GhAuthStatusResult): GhStatusDeps {
  return { ghAuthStatus: () => Promise.resolve(result), now: () => 1_700_000_000_000 }
}

const CHECKED_AT = new Date(1_700_000_000_000).toISOString()

describe('resolveGhStatus', () => {
  it('rejects a payload', async () => {
    await expect(resolveGhStatus({} as unknown as undefined, depsWith({ ok: true, authenticated: true }))).rejects.toThrow("'gh:status' takes no payload")
  })

  it('maps ok+authenticated to signed-in', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: true, authenticated: true }))).resolves.toEqual({ kind: 'signed-in', checkedAt: CHECKED_AT })
  })

  it('maps ok+unauthenticated to signed-out', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: true, authenticated: false }))).resolves.toEqual({ kind: 'signed-out', checkedAt: CHECKED_AT })
  })

  it('maps not-found to missing', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: false, kind: 'not-found', command: 'gh', searched: ['/usr/bin'] }))).resolves.toEqual({
      kind: 'missing',
      checkedAt: CHECKED_AT,
    })
  })

  it('maps every other failure to unknown, carrying a one-line message', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: false, kind: 'timeout', timeoutMs: 8_000, stderr: '' }))).resolves.toEqual({
      kind: 'unknown',
      message: 'gh timed out after 8000ms',
      checkedAt: CHECKED_AT,
    })
    await expect(resolveGhStatus(undefined, depsWith({ ok: false, kind: 'spawn-failed', message: 'boom' }))).resolves.toEqual({
      kind: 'unknown',
      message: 'boom',
      checkedAt: CHECKED_AT,
    })
  })

  it('calls ghAuthStatus with an 8 second timeout', async () => {
    let captured: { timeoutMs?: number } | undefined
    const deps: GhStatusDeps = {
      ghAuthStatus: (options) => {
        captured = options
        return Promise.resolve({ ok: true, authenticated: true })
      },
      now: () => 1_700_000_000_000,
    }
    await resolveGhStatus(undefined, deps)
    expect(captured?.timeoutMs).toBe(8_000)
  })
})

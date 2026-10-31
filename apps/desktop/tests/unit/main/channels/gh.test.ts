import { describe, expect, it } from 'vitest'
import { parseGhAuthStatus, resolveGhStatus } from '@/main/channels/gh'
import type { GhStatusDeps } from '@/main/channels/gh'
import type { GhAuthStatusResult } from '@/types/platform'

function depsWith(result: GhAuthStatusResult): GhStatusDeps {
  return { ghAuthStatus: () => Promise.resolve(result), now: () => 1_700_000_000_000 }
}

const CHECKED_AT = new Date(1_700_000_000_000).toISOString()

const SINGLE_ACCOUNT = `github.com
  ✓ Logged in to github.com account octo (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`

const TWO_ACCOUNTS = `github.com
  ✓ Logged in to github.com account first (keyring)
  - Active account: false
  - Token scopes: 'repo'

  ✓ Logged in to github.com account second (keyring)
  - Active account: true
  - Token scopes: 'repo', 'read:org'
`

describe('parseGhAuthStatus', () => {
  it('reads the account and quote-stripped scopes of a single account', () => {
    expect(parseGhAuthStatus(SINGLE_ACCOUNT)).toEqual({ account: 'octo', scopes: ['gist', 'read:org', 'repo', 'workflow'] })
  })

  it('prefers the active account when several are logged in', () => {
    expect(parseGhAuthStatus(TWO_ACCOUNTS)).toEqual({ account: 'second', scopes: ['repo', 'read:org'] })
  })

  it('falls back to the first account when none is marked active', () => {
    expect(parseGhAuthStatus("  ✓ Logged in to github.com account only (keyring)\n  - Token scopes: 'repo'\n")).toEqual({ account: 'only', scopes: ['repo'] })
  })

  it('reports null scopes, never an empty guess, when there is no scopes line', () => {
    expect(parseGhAuthStatus('  ✓ Logged in to github.com account octo (keyring)\n  - Active account: true\n')).toEqual({ account: 'octo', scopes: null })
  })

  it('reads a literal `none` as an empty scope list', () => {
    expect(parseGhAuthStatus('  ✓ Logged in to github.com account octo (keyring)\n  - Token scopes: none\n')).toEqual({ account: 'octo', scopes: [] })
  })

  it('reports null for both on garbage, the older `as` wording, and empty output', () => {
    expect(parseGhAuthStatus('not gh output at all')).toEqual({ account: null, scopes: null })
    expect(parseGhAuthStatus('✓ Logged in to github.com as octo (oauth_token)')).toEqual({ account: null, scopes: null })
    expect(parseGhAuthStatus('')).toEqual({ account: null, scopes: null })
  })
})

describe('resolveGhStatus', () => {
  it('rejects a payload', async () => {
    await expect(resolveGhStatus({} as unknown as undefined, depsWith({ ok: true, authenticated: true, output: '' }))).rejects.toThrow("'gh:status' takes no payload")
  })

  it('maps ok+authenticated to signed-in with the parsed account and scopes', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: true, authenticated: true, output: SINGLE_ACCOUNT }))).resolves.toEqual({
      kind: 'signed-in',
      checkedAt: CHECKED_AT,
      account: 'octo',
      scopes: ['gist', 'read:org', 'repo', 'workflow'],
    })
  })

  it('keeps signed-in with a null account when the output cannot be parsed', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: true, authenticated: true, output: 'garbage' }))).resolves.toEqual({ kind: 'signed-in', checkedAt: CHECKED_AT, account: null, scopes: null })
  })

  it('maps ok+unauthenticated to signed-out', async () => {
    await expect(resolveGhStatus(undefined, depsWith({ ok: true, authenticated: false, output: '' }))).resolves.toEqual({ kind: 'signed-out', checkedAt: CHECKED_AT })
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
        return Promise.resolve({ ok: true, authenticated: true, output: '' })
      },
      now: () => 1_700_000_000_000,
    }
    await resolveGhStatus(undefined, deps)
    expect(captured?.timeoutMs).toBe(8_000)
  })
})

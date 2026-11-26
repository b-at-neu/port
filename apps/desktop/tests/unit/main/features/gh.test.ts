import { describe, expect, it } from 'vitest'
import { parseGhAuthStatus } from '@/main/features/gh/resolve'
import type { CommandResult } from '@/types/platform'
import { createTestContext, callAction } from '../../../support/context'
import { createFakeClock } from '../../../support/fake-platform'

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

describe('gh.status', () => {
  const status = (result: CommandResult, onRun?: (command: string, args: readonly string[], options: unknown) => void) => {
    const ctx = createTestContext({
      platform: {
        clock: createFakeClock(CHECKED_AT),
        run: (command, args, options) => {
          onRun?.(command, args, options)
          return Promise.resolve(result)
        },
      },
    })
    return callAction(ctx, 'gh.status')
  }

  it('maps a successful run to signed-in with the parsed account and scopes', async () => {
    await expect(status({ ok: true, stdout: SINGLE_ACCOUNT, stderr: '' })).resolves.toEqual({
      kind: 'signed-in',
      checkedAt: CHECKED_AT,
      account: 'octo',
      scopes: ['gist', 'read:org', 'repo', 'workflow'],
    })
  })

  it('reads the account from stderr, where older gh versions print it', async () => {
    await expect(status({ ok: true, stdout: '', stderr: SINGLE_ACCOUNT })).resolves.toMatchObject({ kind: 'signed-in', account: 'octo' })
  })

  it('keeps signed-in with a null account when the output cannot be parsed', async () => {
    await expect(status({ ok: true, stdout: 'garbage', stderr: '' })).resolves.toEqual({ kind: 'signed-in', checkedAt: CHECKED_AT, account: null, scopes: null })
  })

  it('maps a nonzero exit to signed-out', async () => {
    await expect(status({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })).resolves.toEqual({ kind: 'signed-out', checkedAt: CHECKED_AT })
  })

  it('maps not-found to missing', async () => {
    await expect(status({ ok: false, kind: 'not-found', command: 'gh', searched: ['/usr/bin'] })).resolves.toEqual({ kind: 'missing', checkedAt: CHECKED_AT })
  })

  it('maps every other failure to unknown, carrying a one-line message', async () => {
    await expect(status({ ok: false, kind: 'timeout', timeoutMs: 8_000, stderr: '' })).resolves.toEqual({ kind: 'unknown', message: 'gh timed out after 8000ms', checkedAt: CHECKED_AT })
    await expect(status({ ok: false, kind: 'spawn-failed', message: 'boom' })).resolves.toEqual({ kind: 'unknown', message: 'boom', checkedAt: CHECKED_AT })
  })

  it('runs `gh auth status` with an 8 second timeout', async () => {
    let captured: { command: string; args: readonly string[]; options: unknown } | undefined
    await status({ ok: true, stdout: '', stderr: '' }, (command, args, options) => {
      captured = { command, args, options }
    })
    expect(captured).toEqual({ command: 'gh', args: ['auth', 'status'], options: { timeoutMs: 8_000 } })
  })
})

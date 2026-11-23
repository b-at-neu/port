import { describe, expect, it } from 'vitest'
import { argumentRequired, bannerCopy, chipCopy, invokeFailureCopy } from '@/renderer/session/commands-copy'
import type { PluginLoad, SessionCapabilities, SessionInvokeResult } from '@/types/hosting'

function ready(plugin: PluginLoad): SessionCapabilities {
  return { kind: 'ready', commands: [], agents: [], slashCommands: [], plugin }
}

describe('chipCopy', () => {
  it.each([
    [{ kind: 'pending' }, '◌ Pipeline · loading commands…'],
    [{ kind: 'unavailable', message: 'x' }, '⚠ Pipeline commands unavailable'],
    [ready({ kind: 'unconfirmed' }), '◌ port · confirmed on the first turn'],
    [ready({ kind: 'loaded', path: '/x', version: '1.5.3' }), '✓ port 1.5.3'],
    [ready({ kind: 'loaded', path: '/x', version: null }), '✓ port'],
    [ready({ kind: 'missing' }), "⚠ port didn't load"],
    [ready({ kind: 'duplicate', paths: ['/a', '/b'] }), '⚠ Two port plugins loaded'],
  ] as const satisfies readonly (readonly [SessionCapabilities, string])[])('%j', (capabilities, expected) => {
    expect(chipCopy(capabilities)).toBe(expected)
  })
})

describe('bannerCopy', () => {
  it('says nothing while pending, unconfirmed or loaded', () => {
    expect(bannerCopy({ kind: 'pending' })).toBeNull()
    expect(bannerCopy(ready({ kind: 'unconfirmed' }))).toBeNull()
    expect(bannerCopy(ready({ kind: 'loaded', path: '/x', version: null }))).toBeNull()
  })

  it('unavailable carries the SDK message verbatim as detail', () => {
    expect(bannerCopy({ kind: 'unavailable', message: 'boom' })).toEqual({ text: "Claude Code didn't return this session's commands.", detail: 'boom' })
  })

  it('missing names the settings file', () => {
    expect(bannerCopy(ready({ kind: 'missing' }))?.text).toContain('.claude/settings.json')
  })

  it('duplicate lists every path, with "and" before the last', () => {
    expect(bannerCopy(ready({ kind: 'duplicate', paths: ['/a', '/b'] }))?.text).toContain('/a and /b')
    expect(bannerCopy(ready({ kind: 'duplicate', paths: ['/a', '/b', '/c'] }))?.text).toContain('/a, /b, and /c')
  })
})

describe('invokeFailureCopy', () => {
  it('invalid-command names the attempted command and the reason', () => {
    const result: Extract<SessionInvokeResult, { readonly ok: false }> = { ok: false, kind: 'invalid-command', reason: 'the command name is empty' }
    expect(invokeFailureCopy('scope', result)).toBe("Port didn't send /scope: the command name is empty.")
  })

  it('unknown-command names the command from the result itself', () => {
    const result: Extract<SessionInvokeResult, { readonly ok: false }> = { ok: false, kind: 'unknown-command', name: 'nope' }
    expect(invokeFailureCopy('nope', result)).toBe("/nope isn't available in this session any more.")
  })

  it('unknown-session reuses the send-failed copy', () => {
    const result: Extract<SessionInvokeResult, { readonly ok: false }> = { ok: false, kind: 'unknown-session' }
    expect(invokeFailureCopy('pipeline', result)).toContain('no longer has this session')
  })
})

describe('argumentRequired', () => {
  it('a hint starting with < requires the argument', () => {
    expect(argumentRequired('<feature description>')).toBe(true)
  })

  it('an empty hint does not require it', () => {
    expect(argumentRequired('')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { argumentRequired, bannerCopy, chipCopy, invokeFailureCopy } from './commands-copy'
import type { SessionCapabilities, SessionInvokeResult } from '../../../shared/hosting/types'

const INSTALLED_REQUEST = { source: 'installed' as const }
const REPO_REQUEST = { source: 'repository' as const, path: '/repo/plugins/port' }

describe('chipCopy', () => {
  it('pending', () => {
    expect(chipCopy({ kind: 'pending', request: INSTALLED_REQUEST })).toBe('◌ Pipeline · loading commands…')
  })

  it('unavailable', () => {
    expect(chipCopy({ kind: 'unavailable', request: INSTALLED_REQUEST, message: 'x' })).toBe('⚠ Pipeline commands unavailable')
  })

  it('ready + unconfirmed, repository copy', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'unconfirmed' },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(chipCopy(capabilities)).toBe('◌ port · repository copy · confirmed on the first turn')
  })

  it('loaded + complete, with version, installed copy', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: '0.3.1' },
      components: { kind: 'complete' },
    }
    expect(chipCopy(capabilities)).toBe('✓ port 0.3.1 · installed copy')
  })

  it('loaded + complete, version omitted when null', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: null },
      components: { kind: 'complete' },
    }
    expect(chipCopy(capabilities)).toBe('✓ port · installed copy')
  })

  it('loaded + unchecked', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: '0.3.1' },
      components: { kind: 'unchecked', reason: 'unreadable' },
    }
    expect(chipCopy(capabilities)).toBe('◐ port 0.3.1 · components not checked')
  })

  it('loaded + incomplete counts every missing skill and agent', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: '0.3.1' },
      components: { kind: 'incomplete', missingSkills: ['scope'], missingAgents: ['plan-agent'] },
    }
    expect(chipCopy(capabilities)).toBe('⚠ port 0.3.1 · 2 missing')
  })

  it('missing', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'missing' },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(chipCopy(capabilities)).toBe("⚠ port didn't load")
  })

  it('shadowed', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'shadowed', path: '/other', version: null },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(chipCopy(capabilities)).toBe('⚠ port loaded from another copy')
  })

  it('duplicate', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'duplicate', paths: ['/a', '/b'] },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(chipCopy(capabilities)).toBe('⚠ Two port plugins loaded')
  })
})

describe('bannerCopy', () => {
  it('null while pending', () => {
    expect(bannerCopy({ kind: 'pending', request: INSTALLED_REQUEST })).toBeNull()
  })

  it('unavailable carries the SDK message verbatim as detail', () => {
    expect(bannerCopy({ kind: 'unavailable', request: INSTALLED_REQUEST, message: 'boom' })).toEqual({
      text: "Claude Code didn't return this session's commands.",
      detail: 'boom',
    })
  })

  it('null once loaded and complete', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: null },
      components: { kind: 'complete' },
    }
    expect(bannerCopy(capabilities)).toBeNull()
  })

  it('null while loaded but the component check has no plugin path yet — still settling', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: null },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(bannerCopy(capabilities)).toBeNull()
  })

  it('loaded but unreadable names the path that could not be read', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: null },
      components: { kind: 'unchecked', reason: 'unreadable' },
    }
    expect(bannerCopy(capabilities)?.text).toContain('/repo/plugins/port')
  })

  it('missing, repository copy, names the path', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'missing' },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(bannerCopy(capabilities)?.text).toContain('/repo/plugins/port')
  })

  it('missing, installed copy, names the settings file', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'missing' },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(bannerCopy(capabilities)?.text).toContain('.claude/settings.json')
  })

  it('incomplete names each missing skill and agent', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: REPO_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'loaded', path: '/x', version: null },
      components: { kind: 'incomplete', missingSkills: ['release'], missingAgents: [] },
    }
    expect(bannerCopy(capabilities)?.text).toContain('skill `release`')
  })

  it('duplicate names both paths', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'duplicate', paths: ['/a', '/b'] },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(bannerCopy(capabilities)?.text).toBe('Claude Code loaded port from /a and /b. A command may resolve to either copy.')
  })

  it('duplicate with three or more paths reads as a comma list with "and" before the last', () => {
    const capabilities: SessionCapabilities = {
      kind: 'ready',
      request: INSTALLED_REQUEST,
      commands: [],
      agents: [],
      plugin: { kind: 'duplicate', paths: ['/a', '/b', '/c'] },
      components: { kind: 'unchecked', reason: 'no-plugin-path' },
    }
    expect(bannerCopy(capabilities)?.text).toBe('Claude Code loaded port from /a, /b, and /c. A command may resolve to either copy.')
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

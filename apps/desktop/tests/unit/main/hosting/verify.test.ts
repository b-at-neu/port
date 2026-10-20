import { describe, expect, it } from 'vitest'
import { checkComponents, checkPluginLoad, composeInvocation, isBlockedCommand, validateCommandName } from '@/main/hosting/verify'

import type { PluginRequest, InitPlugin } from '@/types/hosting-plugin'

const REPOSITORY: PluginRequest = { source: 'repository', path: '/repo/plugins/port' }
const INSTALLED: PluginRequest = { source: 'installed' }
const samePath = (a: string, b: string) => a === b

describe('checkPluginLoad', () => {
  it('unconfirmed before any init', () => {
    expect(checkPluginLoad({ request: INSTALLED, initPlugins: null, samePath })).toEqual({ kind: 'unconfirmed' })
  })

  it('missing when no plugin named port loaded', () => {
    const plugins: InitPlugin[] = [{ name: 'other', path: '/x' }]
    expect(checkPluginLoad({ request: INSTALLED, initPlugins: plugins, samePath })).toEqual({ kind: 'missing' })
  })

  it('duplicate when two plugins named port loaded', () => {
    const plugins: InitPlugin[] = [{ name: 'port', path: '/a' }, { name: 'port', path: '/b' }]
    expect(checkPluginLoad({ request: INSTALLED, initPlugins: plugins, samePath })).toEqual({ kind: 'duplicate', paths: ['/a', '/b'] })
  })

  it('loaded for the installed source with exactly one match', () => {
    const plugins: InitPlugin[] = [{ name: 'port', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' }]
    expect(checkPluginLoad({ request: INSTALLED, initPlugins: plugins, samePath })).toEqual({ kind: 'loaded', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' })
  })

  it('loaded for the repository source when the loaded path matches the request', () => {
    const plugins: InitPlugin[] = [{ name: 'port', path: '/repo/plugins/port', version: '0.3.1' }]
    expect(checkPluginLoad({ request: REPOSITORY, initPlugins: plugins, samePath })).toEqual({ kind: 'loaded', path: '/repo/plugins/port', version: '0.3.1' })
  })

  it('shadowed for the repository source when the loaded path disagrees', () => {
    const plugins: InitPlugin[] = [{ name: 'port', path: '/other/copy' }]
    expect(checkPluginLoad({ request: REPOSITORY, initPlugins: plugins, samePath })).toEqual({ kind: 'shadowed', path: '/other/copy', version: null })
  })

  it('shadowed when samePath throws on a non-absolute reported path — never guessed as a match', () => {
    const plugins: InitPlugin[] = [{ name: 'port', path: 'relative/path' }]
    const throwingSamePath = (): boolean => {
      throw new TypeError('requires an absolute path')
    }
    expect(checkPluginLoad({ request: REPOSITORY, initPlugins: plugins, samePath: throwingSamePath })).toEqual({ kind: 'shadowed', path: 'relative/path', version: null })
  })
})

describe('checkComponents', () => {
  it('unchecked, no-plugin-path, when expected is null and no read was ever attempted', () => {
    expect(checkComponents({ expected: null, expectedAttempted: false, commandNames: [], agentNames: [] })).toEqual({ kind: 'unchecked', reason: 'no-plugin-path' })
  })

  it('unchecked, unreadable, when expected is null after a read was attempted', () => {
    expect(checkComponents({ expected: null, expectedAttempted: true, commandNames: [], agentNames: [] })).toEqual({ kind: 'unchecked', reason: 'unreadable' })
  })

  it('complete when every expected skill and agent is present', () => {
    const result = checkComponents({ expected: { skills: ['pipeline'], agents: ['plan-agent'] }, expectedAttempted: true, commandNames: ['pipeline', 'scope'], agentNames: ['plan-agent'] })
    expect(result).toEqual({ kind: 'complete' })
  })

  it('incomplete naming exactly the missing skills and agents', () => {
    const result = checkComponents({ expected: { skills: ['pipeline', 'scope'], agents: ['plan-agent', 'impl-agent'] }, expectedAttempted: true, commandNames: ['pipeline'], agentNames: [] })
    expect(result).toEqual({ kind: 'incomplete', missingSkills: ['scope'], missingAgents: ['plan-agent', 'impl-agent'] })
  })
})

describe('validateCommandName', () => {
  it('accepts a canonical name', () => {
    expect(validateCommandName('pipeline')).toEqual({ ok: true })
  })

  it('rejects an empty name', () => {
    const result = validateCommandName('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.reason).toBe('string')
  })

  it('rejects surrounding whitespace', () => {
    expect(validateCommandName(' pipeline ').ok).toBe(false)
  })

  it('rejects a leading slash', () => {
    expect(validateCommandName('/pipeline').ok).toBe(false)
  })

  it('rejects a bare wildcard and suffixed wildcards', () => {
    expect(validateCommandName('*').ok).toBe(false)
    expect(validateCommandName('pipeline:*').ok).toBe(false)
    expect(validateCommandName('pipeline *').ok).toBe(false)
  })

  it('rejects parentheses and commas', () => {
    expect(validateCommandName('pipeline(1)').ok).toBe(false)
    expect(validateCommandName('pipeline,scope').ok).toBe(false)
  })

  it('rejects control characters', () => {
    expect(validateCommandName('pipe\u0007line').ok).toBe(false)
  })

  it('rejects a backslash anywhere, including trailing', () => {
    expect(validateCommandName('pipe\\line').ok).toBe(false)
    expect(validateCommandName('pipeline\\').ok).toBe(false)
  })
})

describe('isBlockedCommand', () => {
  const NONE = { stage: false, portNames: [], unqualifiedNames: [] }
  const OWN_PIPELINE = { stage: false, portNames: [], unqualifiedNames: ['pipeline'] }
  const STAGE = { stage: true, portNames: ['scope', 'release'], unqualifiedNames: ['review'] }

  it('is true for port:pipeline regardless of what the session reports', () => {
    expect(isBlockedCommand('port:pipeline', NONE)).toBe(true)
    expect(isBlockedCommand('port:pipeline', OWN_PIPELINE)).toBe(true)
  })

  it('is true for a bare pipeline only when the session reports no unqualified pipeline of its own', () => {
    expect(isBlockedCommand('pipeline', NONE)).toBe(true)
    expect(isBlockedCommand('pipeline', OWN_PIPELINE)).toBe(false)
  })

  it('never matches on a substring', () => {
    expect(isBlockedCommand('pipeline-report', NONE)).toBe(false)
    expect(isBlockedCommand('port:pipeline-status', NONE)).toBe(false)
  })

  it('leaves every other port command alone in an interactive session', () => {
    expect(isBlockedCommand('port:scope', { ...NONE, portNames: ['scope'] })).toBe(false)
    expect(isBlockedCommand('scope', { ...NONE, portNames: ['scope'] })).toBe(false)
  })

  it('blocks any port:-qualified name in a stage session', () => {
    expect(isBlockedCommand('port:scope', STAGE)).toBe(true)
    expect(isBlockedCommand('port:release', STAGE)).toBe(true)
    expect(isBlockedCommand('port:pipeline', STAGE)).toBe(true)
  })

  it('blocks a bare port command name in a stage session unless the session reports it as its own', () => {
    expect(isBlockedCommand('scope', STAGE)).toBe(true)
    expect(isBlockedCommand('scope', { ...STAGE, unqualifiedNames: ['scope'] })).toBe(false)
  })

  it('allows a command that is not a port command in a stage session', () => {
    expect(isBlockedCommand('review', STAGE)).toBe(false)
    expect(isBlockedCommand('other:cmd', STAGE)).toBe(false)
  })

  it('matches exactly in a stage session, never a near-miss', () => {
    expect(isBlockedCommand('scope-x', STAGE)).toBe(false)
    expect(isBlockedCommand('sco', STAGE)).toBe(false)
    expect(isBlockedCommand('portscope', STAGE)).toBe(false)
  })
})

describe('composeInvocation', () => {
  it('composes a bare command with no args', () => {
    expect(composeInvocation('pipeline', '')).toBe('/pipeline')
  })

  it('trims and appends non-empty args', () => {
    expect(composeInvocation('scope', '  add a thing  ')).toBe('/scope add a thing')
  })

  it('composes a bare command when args is only whitespace', () => {
    expect(composeInvocation('pipeline', '   ')).toBe('/pipeline')
  })
})

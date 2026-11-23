import { describe, expect, it } from 'vitest'
import { checkPluginLoad, composeInvocation, isBlockedCommand, validateCommandName, type InitPlugin } from '@/main/hosting/verify'

describe('checkPluginLoad', () => {
  it.each([
    ['unconfirmed before any init', null, { kind: 'unconfirmed' }],
    ['missing when no plugin named port loaded', [{ name: 'other', path: '/x' }], { kind: 'missing' }],
    ['duplicate when two plugins named port loaded', [{ name: 'port', path: '/a' }, { name: 'port', path: '/b' }], { kind: 'duplicate', paths: ['/a', '/b'] }],
    ['loaded with exactly one match', [{ name: 'port', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' }], { kind: 'loaded', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' }],
    ['loaded without a version', [{ name: 'port', path: '/p' }], { kind: 'loaded', path: '/p', version: null }],
  ] as const satisfies readonly (readonly [string, readonly InitPlugin[] | null, object])[])('%s', (_name, initPlugins, expected) => {
    expect(checkPluginLoad({ initPlugins })).toEqual(expected)
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

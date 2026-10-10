import { describe, expect, it, vi } from 'vitest'
import { buildSessionOptions, SETTING_SOURCES } from './options'
import type { CanUseTool } from './sdk'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import type { PluginRequest } from '../../shared/hosting/types'

const canUseTool = vi.fn() as unknown as CanUseTool
const INSTALLED: PluginRequest = { source: 'installed' }
const REPOSITORY: PluginRequest = { source: 'repository', path: '/repo/plugins/port' }
const BASE = { cwd: '/repo', executablePath: '/home/operator/.local/bin/claude', canUseTool, plugin: INSTALLED, defaults: DEFAULT_SESSION_DEFAULTS, stage: null }

describe('buildSessionOptions', () => {
  it('every mode carries the shared constants', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } })
    expect(options.cwd).toBe('/repo')
    expect(options.pathToClaudeCodeExecutable).toBe('/home/operator/.local/bin/claude')
    expect(options.persistSession).toBe(true)
    expect(options.includePartialMessages).toBe(true)
    expect(options.permissionMode).toBe('default')
    expect(options.canUseTool).toBe(canUseTool)
    expect(options.permissionPromptToolName).toBeUndefined()
  })

  it('fresh carries no resume-shaped field', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } })
    expect(options.resume).toBeUndefined()
    expect(options.forkSession).toBeUndefined()
    expect(options.resumeSessionAt).toBeUndefined()
  })

  it('resume carries resume alone', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'resume', sessionId: 'abc' } })
    expect(options.resume).toBe('abc')
    expect(options.forkSession).toBeUndefined()
    expect(options.resumeSessionAt).toBeUndefined()
  })

  it('resume-at carries resume and resumeSessionAt, and resumeDropsTurn only when given', () => {
    const withoutDrop = buildSessionOptions({ ...BASE, mode: { kind: 'resume-at', sessionId: 'abc', messageUuid: 'msg-1', resumeDropsTurn: null } })
    expect(withoutDrop.resume).toBe('abc')
    expect(withoutDrop.resumeSessionAt).toBe('msg-1')
    expect(withoutDrop.resumeDropsTurn).toBeUndefined()

    const withDrop = buildSessionOptions({ ...BASE, mode: { kind: 'resume-at', sessionId: 'abc', messageUuid: 'msg-1', resumeDropsTurn: 'turn-1' } })
    expect(withDrop.resumeDropsTurn).toBe('turn-1')
  })

  it('fork carries resume and forkSession: true', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fork', sessionId: 'parent-id' } })
    expect(options.resume).toBe('parent-id')
    expect(options.forkSession).toBe(true)
  })

  it('sessionId is never passed for any mode — the init message is the only source', () => {
    for (const mode of [
      { kind: 'fresh' as const },
      { kind: 'resume' as const, sessionId: 'x' },
      { kind: 'resume-at' as const, sessionId: 'x', messageUuid: 'y', resumeDropsTurn: null },
      { kind: 'fork' as const, sessionId: 'x' },
    ]) {
      const options = buildSessionOptions({ ...BASE, mode })
      expect(options.sessionId).toBeUndefined()
    }
  })

  const MODES = [
    { kind: 'fresh' as const },
    { kind: 'resume' as const, sessionId: 'x' },
    { kind: 'resume-at' as const, sessionId: 'x', messageUuid: 'y', resumeDropsTurn: null },
    { kind: 'fork' as const, sessionId: 'x' },
  ]

  it('settingSources is always the three explicit sources, never omitted, in every start mode', () => {
    for (const mode of MODES) {
      const options = buildSessionOptions({ ...BASE, mode, plugin: INSTALLED })
      expect(options.settingSources).toEqual([...SETTING_SOURCES])
    }
  })

  it('the installed source passes no plugins option, in every start mode', () => {
    for (const mode of MODES) {
      const options = buildSessionOptions({ ...BASE, mode, plugin: INSTALLED })
      expect(options.plugins).toBeUndefined()
    }
  })

  it('the repository source passes one local plugin entry at its own path, in every start mode', () => {
    for (const mode of MODES) {
      const options = buildSessionOptions({ ...BASE, mode, plugin: REPOSITORY })
      expect(options.plugins).toEqual([{ type: 'local', path: '/repo/plugins/port' }])
    }
  })

  it('never sets a skills option key', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, plugin: REPOSITORY })
    expect((options as Record<string, unknown>)['skills']).toBeUndefined()
  })
})

describe('buildSessionOptions — operator session defaults (#364)', () => {
  it("the operator role reads permissionMode from defaults, never a bare 'default'", () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: null, permissionMode: 'acceptEdits' } })
    expect(options.permissionMode).toBe('acceptEdits')
  })

  it('model is set only when defaults.model is non-null', () => {
    const withNull = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: null, permissionMode: 'default' } })
    expect(withNull.model).toBeUndefined()

    const withModel = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: 'opus', permissionMode: 'default' } })
    expect(withModel.model).toBe('opus')
  })
})

describe('buildSessionOptions — stage branch (#327)', () => {
  it('sets agent, model and permissionMode: default from stage, never reading defaults', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: 'haiku', permissionMode: 'acceptEdits' }, stage: { agentName: 'port:impl-agent', model: 'sonnet' } })
    expect(options.permissionMode).toBe('default')
    expect(options.model).toBe('sonnet')
    expect((options as Record<string, unknown>)['agent']).toBe('port:impl-agent')
  })

  it('adds no tools, allowedTools, systemPrompt or bypassPermissions', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, stage: { agentName: 'port:plan-agent', model: 'opus' } }) as Record<string, unknown>
    expect(options['tools']).toBeUndefined()
    expect(options['allowedTools']).toBeUndefined()
    expect(options['systemPrompt']).toBeUndefined()
    expect(options['bypassPermissions']).toBeUndefined()
  })
})

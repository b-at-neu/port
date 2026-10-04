import { describe, expect, it, vi } from 'vitest'
import { buildSessionOptions, SETTING_SOURCES } from './options'
import type { CanUseTool } from './sdk'
import type { PluginRequest } from '../../shared/hosting/types'

const canUseTool = vi.fn() as unknown as CanUseTool
const INSTALLED: PluginRequest = { source: 'installed' }
const REPOSITORY: PluginRequest = { source: 'repository', path: '/repo/plugins/port' }
const BASE = { cwd: '/repo', executablePath: '/home/operator/.local/bin/claude', canUseTool, plugin: INSTALLED }

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

describe('buildSessionOptions — dispatcher role (#265)', () => {
  it('defaults to the operator role, adding none of the four dispatcher-only fields', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } })
    expect(options.model).toBeUndefined()
    expect(options.systemPrompt).toBeUndefined()
    expect(options.allowedTools).toBeUndefined()
    expect(options.title).toBeUndefined()
  })

  it('the dispatcher role sets model, systemPrompt append, allowedTools, and title', () => {
    const options = buildSessionOptions({
      ...BASE,
      mode: { kind: 'fresh' },
      role: { kind: 'dispatcher', model: 'haiku', instructions: 'Make only the calls named, verbatim.', title: 'Port dispatcher · acme/widgets' },
    })
    expect(options.model).toBe('haiku')
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Make only the calls named, verbatim.' })
    expect(options.allowedTools).toEqual(['Agent', 'SendMessage'])
    expect(options.title).toBe('Port dispatcher · acme/widgets')
  })

  it('never sets a tools option key — that would strip Bash/Write from the stage agents it spawns', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, role: { kind: 'dispatcher', model: 'haiku', instructions: 'x', title: 'y' } })
    expect((options as Record<string, unknown>)['tools']).toBeUndefined()
  })

  it('the dispatcher role still carries permissionMode/canUseTool/settingSources/plugins unchanged', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, plugin: REPOSITORY, role: { kind: 'dispatcher', model: 'haiku', instructions: 'x', title: 'y' } })
    expect(options.permissionMode).toBe('default')
    expect(options.canUseTool).toBe(canUseTool)
    expect(options.settingSources).toEqual([...SETTING_SOURCES])
    expect(options.plugins).toEqual([{ type: 'local', path: '/repo/plugins/port' }])
  })
})

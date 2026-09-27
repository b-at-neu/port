import { describe, expect, it } from 'vitest'
import { buildSessionOptions } from './options'

const BASE = { cwd: '/repo', executablePath: '/home/operator/.local/bin/claude' }

describe('buildSessionOptions', () => {
  it('every mode carries the shared constants', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } })
    expect(options.cwd).toBe('/repo')
    expect(options.pathToClaudeCodeExecutable).toBe('/home/operator/.local/bin/claude')
    expect(options.persistSession).toBe(true)
    expect(options.includePartialMessages).toBe(true)
    expect(options.permissionMode).toBe('dontAsk')
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
})

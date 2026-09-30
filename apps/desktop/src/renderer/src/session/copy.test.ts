import { describe, expect, it } from 'vitest'
import type { SessionEnd, SessionStartResult } from '../../../shared/hosting/types'
import { composerCopy, endBody, interruptNote, startFailureCopy } from './copy'

describe('composerCopy', () => {
  it('ready and starting offer Send, never disabled', () => {
    expect(composerCopy('ready')).toEqual({ disabled: false, placeholder: 'Message Claude…', sendLabel: 'Send' })
    expect(composerCopy('starting')).toEqual({ disabled: false, placeholder: 'Message Claude…', sendLabel: 'Send' })
  })

  it('streaming and interrupting offer Queue with the working placeholder', () => {
    expect(composerCopy('streaming').sendLabel).toBe('Queue')
    expect(composerCopy('streaming').placeholder).toContain('runs next')
    expect(composerCopy('interrupting').sendLabel).toBe('Queue')
  })

  it('closing and ended are disabled with no send button', () => {
    expect(composerCopy('closing').disabled).toBe(true)
    expect(composerCopy('closing').sendLabel).toBeNull()
    expect(composerCopy('ended').disabled).toBe(true)
    expect(composerCopy('ended').sendLabel).toBeNull()
  })
})

function end(overrides: Partial<SessionEnd>): SessionEnd {
  return { reason: 'completed', exitCode: null, signal: null, message: null, diagnosis: null, ...overrides }
}

describe('endBody', () => {
  it('fills in exitCode for exit-nonzero', () => {
    expect(endBody(end({ reason: 'exit-nonzero', exitCode: 1 }))).toBe('Claude Code exited with code 1.')
  })

  it('fills in signal for signal', () => {
    expect(endBody(end({ reason: 'signal', signal: 'SIGKILL' }))).toBe('Claude Code was stopped by signal SIGKILL.')
  })

  it('carries no placeholder for completed', () => {
    expect(endBody(end({ reason: 'completed' }))).toBe('Claude Code ended the session.')
  })
})

describe('startFailureCopy', () => {
  it('names the limit for at-capacity', () => {
    const result: Extract<SessionStartResult, { ok: false }> = { ok: false, kind: 'at-capacity', limit: 4 }
    expect(startFailureCopy(result).body).toContain('4 sessions')
  })

  it('reuses RUNTIME_COPY for a runtime failure, carrying detail through', () => {
    const result: Extract<SessionStartResult, { ok: false }> = { ok: false, kind: 'runtime', diagnosis: 'cli-missing', detail: 'not on PATH' }
    const copy = startFailureCopy(result)
    expect(copy.title).toContain("isn't installed")
    expect(copy.detail).toBe('not on PATH')
  })
})

describe('interruptNote', () => {
  it('names the count when positive', () => {
    expect(interruptNote(2)).toBe('Stopped. 2 queued messages will still run.')
    expect(interruptNote(1)).toBe('Stopped. 1 queued message will still run.')
  })

  it('is null, never a note, when zero', () => {
    expect(interruptNote(0)).toBeNull()
  })

  it('reports an unconfirmed count as such, never coerced to zero', () => {
    expect(interruptNote(null)).toContain("couldn't confirm")
  })
})

import { describe, expect, it } from 'vitest'
import { promptTitle, recordTitle, resolveStartTitle } from './title'
import type { SessionReader } from '../sessions/sdk'

function session(overrides: Partial<{ sessionId: string; customTitle: string | null; summary: string | null; firstPrompt: string | null }> = {}) {
  return {
    sessionId: 'session-1',
    summary: null,
    lastModified: '2026-01-01T00:00:00.000Z',
    customTitle: null,
    firstPrompt: null,
    gitBranch: null,
    cwd: null,
    ...overrides,
  }
}

describe('promptTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(promptTitle('  fix   the   thing  ')).toBe('fix the thing')
  })

  it('returns null for text that is empty after trimming', () => {
    expect(promptTitle('   ')).toBeNull()
  })

  it('caps at 60 characters with an ellipsis', () => {
    const long = 'a'.repeat(80)
    const result = promptTitle(long)
    expect(result).toBe(`${'a'.repeat(60)}…`)
  })

  it('falls back to the first attachment name when the text is empty', () => {
    expect(promptTitle('', 'photo.png')).toBe('photo.png')
  })

  it('prefers the text over the attachment name when both are present', () => {
    expect(promptTitle('describe this', 'photo.png')).toBe('describe this')
  })

  it('returns null when both the text and the attachment name are empty', () => {
    expect(promptTitle('', null)).toBeNull()
  })
})

describe('recordTitle', () => {
  it('prefers customTitle', () => {
    expect(recordTitle(session({ customTitle: 'Custom', summary: 'Summary', firstPrompt: 'Prompt' }))).toBe('Custom')
  })

  it('falls back to summary', () => {
    expect(recordTitle(session({ summary: 'Summary', firstPrompt: 'Prompt' }))).toBe('Summary')
  })

  it('falls back to firstPrompt', () => {
    expect(recordTitle(session({ firstPrompt: 'Prompt' }))).toBe('Prompt')
  })

  it('returns null when nothing is set', () => {
    expect(recordTitle(session())).toBeNull()
  })
})

describe('resolveStartTitle', () => {
  it('resolves null for a fresh session without reading anything', async () => {
    const listSessions: SessionReader = () => Promise.reject(new Error('must not be called'))
    await expect(resolveStartTitle({ kind: 'fresh' }, listSessions)).resolves.toBeNull()
  })

  it('resolves the target record title for resume', async () => {
    const listSessions: SessionReader = () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', summary: 'Parent' })] })
    await expect(resolveStartTitle({ kind: 'resume', sessionId: 'parent-1' }, listSessions)).resolves.toBe('Parent')
  })

  it('resolves the target record title for resume-at', async () => {
    const listSessions: SessionReader = () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', summary: 'Parent' })] })
    await expect(resolveStartTitle({ kind: 'resume-at', sessionId: 'parent-1', messageUuid: 'uuid-1', resumeDropsTurn: null }, listSessions)).resolves.toBe('Parent')
  })

  it('resolves forkTitle(parentTitle) for fork', async () => {
    const listSessions: SessionReader = () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', summary: 'Parent' })] })
    await expect(resolveStartTitle({ kind: 'fork', sessionId: 'parent-1' }, listSessions)).resolves.toBe('Parent (fork)')
  })

  it('resolves null when the reader fails', async () => {
    const listSessions: SessionReader = () => Promise.resolve({ ok: false, kind: 'sdk-unavailable', message: 'nope' })
    await expect(resolveStartTitle({ kind: 'resume', sessionId: 'parent-1' }, listSessions)).resolves.toBeNull()
  })

  it('resolves null when the target is no longer listed', async () => {
    const listSessions: SessionReader = () => Promise.resolve({ ok: true, sessions: [] })
    await expect(resolveStartTitle({ kind: 'resume', sessionId: 'parent-1' }, listSessions)).resolves.toBeNull()
  })

  it('resolves null when the reader throws', async () => {
    const listSessions: SessionReader = () => Promise.reject(new Error('boom'))
    await expect(resolveStartTitle({ kind: 'resume', sessionId: 'parent-1' }, listSessions)).resolves.toBeNull()
  })
})

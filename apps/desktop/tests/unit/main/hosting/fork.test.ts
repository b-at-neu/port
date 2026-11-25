import { describe, expect, it, vi } from 'vitest'
import { forkRename, forkTitle, titleFork } from '@/main/sessions/hosting/fork'
import type { ListSessionsResult, RawSession } from '@/types/sessions'

function session(overrides: Partial<RawSession>): RawSession {
  return { sessionId: 's', summary: null, lastModified: '2026-01-01T00:00:00.000Z', customTitle: null, firstPrompt: null, gitBranch: null, cwd: null, ...overrides }
}

describe('forkTitle', () => {
  it('appends the fork suffix', () => {
    expect(forkTitle('Fix the login bug')).toMatch(/^Fix the login bug \S/)
  })

  it('trims surrounding whitespace before appending', () => {
    expect(forkTitle('  spaced  ')).toBe('spaced (fork)')
  })

  it('never exceeds 80 characters', () => {
    const long = 'x'.repeat(200)
    const result = forkTitle(long)
    expect(result.length).toBeLessThanOrEqual(80)
    expect(result.endsWith(' (fork)')).toBe(true)
  })
})

describe('forkRename', () => {
  const params = { parentSessionId: 'parent-1', forkedSessionId: 'fork-1' }
  const listing = (...sessions: RawSession[]): ListSessionsResult => ({ ok: true, sessions })

  it.each<{ readonly name: string; readonly list: ListSessionsResult; readonly expected: ReturnType<typeof forkRename> }>([
    { name: 'prefers the parent customTitle', list: listing(session({ sessionId: 'parent-1', customTitle: 'My custom title', summary: 'ignored', firstPrompt: 'ignored' })), expected: { kind: 'rename', title: 'My custom title (fork)' } },
    { name: 'falls back to the parent summary', list: listing(session({ sessionId: 'parent-1', summary: 'a summary', firstPrompt: 'ignored' })), expected: { kind: 'rename', title: 'a summary (fork)' } },
    { name: 'falls back to the parent firstPrompt', list: listing(session({ sessionId: 'parent-1', firstPrompt: 'do the thing' })), expected: { kind: 'rename', title: 'do the thing (fork)' } },
    { name: 'is already titled when the fork carries a custom title', list: listing(session({ sessionId: 'fork-1', customTitle: 'already named' }), session({ sessionId: 'parent-1', customTitle: 'Parent' })), expected: { kind: 'titled' } },
    { name: 'does nothing when the parent has no title', list: listing(session({ sessionId: 'parent-1' })), expected: { kind: 'none' } },
    { name: 'does nothing when the parent is not listed', list: listing(), expected: { kind: 'none' } },
    { name: 'does nothing when the session list itself failed', list: { ok: false, kind: 'sdk-unavailable', message: 'no sdk' }, expected: { kind: 'none' } },
  ])('$name', ({ list, expected }) => {
    expect(forkRename(list, params)).toEqual(expected)
  })
})

describe('titleFork', () => {
  it('reports false, never throws, when renameSession itself rejects', async () => {
    const renameSession = vi.fn(() => Promise.reject(new Error('disk full')))
    const listSessions = () => Promise.resolve<ListSessionsResult>({ ok: true, sessions: [session({ sessionId: 'parent-1', customTitle: 'Title' })] })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(titleFork({ renameSession }, listSessions, { parentSessionId: 'parent-1', forkedSessionId: 'fork-1', cwd: '/repo' })).resolves.toBe(false)
    expect(renameSession).toHaveBeenCalledWith('fork-1', 'Title (fork)', { dir: '/repo' })
  })
})

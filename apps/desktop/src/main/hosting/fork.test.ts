import { describe, expect, it, vi } from 'vitest'
import { forkTitle, titleFork } from './fork'
import type { TitleForkDeps } from './fork'
import type { RawSession } from '../sessions/sdk'

function session(overrides: Partial<RawSession>): RawSession {
  return { sessionId: 's', summary: null, lastModified: '2026-01-01T00:00:00.000Z', customTitle: null, firstPrompt: null, gitBranch: null, cwd: null, ...overrides }
}

describe('forkTitle', () => {
  it('appends the fork suffix', () => {
    expect(forkTitle('Fix the login bug')).toBe('Fix the login bug (fork)')
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

describe('titleFork', () => {
  const params = { parentSessionId: 'parent-1', forkedSessionId: 'fork-1', cwd: '/repo' }

  function deps(overrides: Partial<TitleForkDeps> = {}): TitleForkDeps {
    return { listSessions: vi.fn(() => Promise.resolve({ ok: true as const, sessions: [] })), renameSession: vi.fn(() => Promise.resolve(undefined)), ...overrides }
  }

  it('resolves the parent title as customTitle first', async () => {
    const rename = vi.fn(() => Promise.resolve(undefined))
    const d = deps({
      listSessions: () =>
        Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', customTitle: 'My custom title', summary: 'ignored', firstPrompt: 'ignored' })] }),
      renameSession: rename,
    })
    const titled = await titleFork(params, d)
    expect(titled).toBe(true)
    expect(rename).toHaveBeenCalledWith('fork-1', 'My custom title (fork)', { dir: '/repo' })
  })

  it('falls back to summary, then firstPrompt', async () => {
    const rename = vi.fn(() => Promise.resolve(undefined))
    const d = deps({ listSessions: () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', summary: 'a summary' })] }), renameSession: rename })
    await titleFork(params, d)
    expect(rename).toHaveBeenCalledWith('fork-1', 'a summary (fork)', { dir: '/repo' })

    const rename2 = vi.fn(() => Promise.resolve(undefined))
    const d2 = deps({ listSessions: () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', firstPrompt: 'do the thing' })] }), renameSession: rename2 })
    await titleFork(params, d2)
    expect(rename2).toHaveBeenCalledWith('fork-1', 'do the thing (fork)', { dir: '/repo' })
  })

  it('is skipped, and reported titled, when the fork already carries a custom title', async () => {
    const rename = vi.fn(() => Promise.resolve(undefined))
    const d = deps({ listSessions: () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'fork-1', customTitle: 'already named' })] }), renameSession: rename })
    const titled = await titleFork(params, d)
    expect(titled).toBe(true)
    expect(rename).not.toHaveBeenCalled()
  })

  it('reports false, never throws, when nothing resolves a parent title', async () => {
    const d = deps({ listSessions: () => Promise.resolve({ ok: true, sessions: [] }) })
    await expect(titleFork(params, d)).resolves.toBe(false)
  })

  it('reports false, never throws, when the session list itself failed', async () => {
    const d = deps({ listSessions: () => Promise.resolve({ ok: false, kind: 'sdk-unavailable', message: 'no sdk' }) })
    await expect(titleFork(params, d)).resolves.toBe(false)
  })

  it('reports false, never throws, when renameSession itself rejects', async () => {
    const d = deps({
      listSessions: () => Promise.resolve({ ok: true, sessions: [session({ sessionId: 'parent-1', customTitle: 'Title' })] }),
      renameSession: vi.fn(() => Promise.reject(new Error('disk full'))),
    })
    await expect(titleFork(params, d)).resolves.toBe(false)
  })
})

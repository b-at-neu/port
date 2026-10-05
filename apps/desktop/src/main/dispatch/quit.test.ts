import { describe, expect, it, vi } from 'vitest'
import { createQuitGuard, quitWarningCopy, stagePhaseName } from './quit'
import type { StageSessionSummary } from './quit'

function session(overrides: Partial<StageSessionSummary> = {}): StageSessionSummary {
  return { agent: 'impl', number: 300, trigger: 'planApproved', repoName: 'acme/widgets', ...overrides }
}

describe('stagePhaseName', () => {
  it('names every agent', () => {
    expect(stagePhaseName('plan', 'planChangesRequested')).toBe('planning')
    expect(stagePhaseName('impl', 'planApproved')).toBe('implementing')
    expect(stagePhaseName('review', 'readyForReview')).toBe('reviewing')
    expect(stagePhaseName('revise', 'needsHuman')).toBe('revising')
  })

  it('a refreshBranch trigger is always refreshing, regardless of agent', () => {
    expect(stagePhaseName('impl', 'refreshBranch')).toBe('refreshing')
  })
})

describe('quitWarningCopy', () => {
  it('returns null for an empty list', () => {
    expect(quitWarningCopy([])).toBeNull()
  })

  it('uses singular copy for one session', () => {
    const copy = quitWarningCopy([session()])
    expect(copy?.message).toBe('Quit port and stop 1 stage session?')
    expect(copy?.confirmLabel).toBe('Stop session and quit')
    expect(copy?.detail).toContain('#300 implementing · acme/widgets')
    expect(copy?.detail).toContain('Quitting interrupts it where it is.')
  })

  it('uses plural copy and sorts by repo then number for several sessions', () => {
    const copy = quitWarningCopy([session({ number: 312, repoName: 'acme/widgets', agent: 'review' }), session({ number: 52, repoName: 'acme/api', agent: 'impl' })])
    expect(copy?.message).toBe('Quit port and stop 2 stage sessions?')
    expect(copy?.confirmLabel).toBe('Stop sessions and quit')
    const lines = copy?.detail.split('\n') ?? []
    expect(lines[0]).toBe('#52 implementing · acme/api')
    expect(lines[1]).toBe('#312 reviewing · acme/widgets')
  })
})

describe('createQuitGuard', () => {
  it('never intercepts when there are no live sessions', () => {
    const guard = createQuitGuard({ sessions: () => [], confirm: () => Promise.resolve(true), quit: vi.fn() })
    expect(guard.intercept(() => undefined)).toBe(false)
  })

  it('prevents and prompts once, calling quit on confirm', async () => {
    const quit = vi.fn()
    const prevented = vi.fn()
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(true), quit })
    expect(guard.intercept(prevented)).toBe(true)
    expect(prevented).toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).toHaveBeenCalled()
  })

  it('cancel never calls quit, and a later intercept prompts again', async () => {
    const quit = vi.fn()
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(false), quit })
    guard.intercept(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(guard.intercept(() => undefined)).toBe(true)
  })

  it('a second intercept while a prompt is open prevents without a second dialog', () => {
    let confirmCalls = 0
    const guard = createQuitGuard({
      sessions: () => [session()],
      confirm: () => {
        confirmCalls += 1
        return new Promise(() => undefined) // never resolves — simulates an open dialog
      },
      quit: vi.fn(),
    })
    guard.intercept(() => undefined)
    guard.intercept(() => undefined)
    expect(confirmCalls).toBe(1)
  })

  it('a rejecting confirm is treated as confirm — fails open', async () => {
    const quit = vi.fn()
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.reject(new Error('dialog broke')), quit })
    guard.intercept(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).toHaveBeenCalled()
  })

  it('once confirmed, a later intercept passes through unintercepted', async () => {
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(true), quit: vi.fn() })
    guard.intercept(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(guard.intercept(() => undefined)).toBe(false)
  })
})

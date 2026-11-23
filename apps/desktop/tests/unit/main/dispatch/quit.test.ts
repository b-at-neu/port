import { describe, expect, it, vi } from 'vitest'
import { createQuitGuard, quitWarningCopy, stagePhaseName } from '@/main/dispatch/quit'
import type { StageSessionSummary } from '@/types/dispatch'

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
    const plural = quitWarningCopy([session(), session({ number: 301 })])
    expect(copy?.message).toContain('1')
    expect(copy?.confirmLabel).not.toBe(plural?.confirmLabel)
    expect(copy?.detail).toContain('#300 implementing · acme/widgets')
  })

  it('uses plural copy and sorts by repo then number for several sessions', () => {
    const copy = quitWarningCopy([session({ number: 312, repoName: 'acme/widgets', agent: 'review' }), session({ number: 52, repoName: 'acme/api', agent: 'impl' })])
    expect(copy?.message).toContain('2')
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

  it('prepare with no sessions confirms, and a later intercept passes', async () => {
    const guard = createQuitGuard({ sessions: () => [], confirm: () => Promise.resolve(false), quit: vi.fn() })
    expect(await guard.prepare()).toBe(true)
    expect(guard.intercept(() => undefined)).toBe(false)
  })

  it('prepare with sessions confirms without ever calling quit', async () => {
    const quit = vi.fn()
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(true), quit })
    expect(await guard.prepare()).toBe(true)
    expect(quit).not.toHaveBeenCalled()
    expect(guard.intercept(() => undefined)).toBe(false)
  })

  it('prepare cancelled returns false, and a later intercept still prompts', async () => {
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(false), quit: vi.fn() })
    expect(await guard.prepare()).toBe(false)
    expect(guard.intercept(() => undefined)).toBe(true)
  })

  it('prepare while a prompt is open returns false without a second dialog', async () => {
    let confirmCalls = 0
    const guard = createQuitGuard({
      sessions: () => [session()],
      confirm: () => {
        confirmCalls += 1
        return new Promise(() => undefined)
      },
      quit: vi.fn(),
    })
    guard.intercept(() => undefined)
    expect(await guard.prepare()).toBe(false)
    expect(confirmCalls).toBe(1)
  })

  it('cancelPrepared makes a later intercept prompt again', async () => {
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(true), quit: vi.fn() })
    await guard.prepare()
    guard.cancelPrepared()
    expect(guard.intercept(() => undefined)).toBe(true)
  })

  it('once confirmed, a later intercept passes through unintercepted', async () => {
    const guard = createQuitGuard({ sessions: () => [session()], confirm: () => Promise.resolve(true), quit: vi.fn() })
    guard.intercept(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(guard.intercept(() => undefined)).toBe(false)
  })
})

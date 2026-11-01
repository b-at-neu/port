import { describe, expect, it, vi } from 'vitest'
import { MAX_NOTIFICATION_TEXT, resolveNotifyNeedsYou, resolveNotifyPrefs, resolveNotifyPrefsSet } from '@/main/channels/notify'

describe('resolveNotifyNeedsYou', () => {
  it('passes a valid request to the shower unchanged', () => {
    const show = vi.fn()
    resolveNotifyNeedsYou({ title: 'port · #552', body: 'Review the plan', focus: 'plan-review:r:552:t' }, { show })
    expect(show).toHaveBeenCalledWith({ title: 'port · #552', body: 'Review the plan', focus: 'plan-review:r:552:t' })
  })

  it('accepts a null focus', () => {
    const show = vi.fn()
    resolveNotifyNeedsYou({ title: 'port', body: '3 new items need you', focus: null }, { show })
    expect(show).toHaveBeenCalledOnce()
  })

  it.each([
    ['an empty title', { title: '', body: 'b', focus: null }],
    ['a non-string title', { title: 4, body: 'b', focus: null }],
    ['an empty body', { title: 't', body: '', focus: null }],
    ['an over-long body', { title: 't', body: 'x'.repeat(MAX_NOTIFICATION_TEXT + 1), focus: null }],
    ['a numeric focus', { title: 't', body: 'b', focus: 3 }],
    ['an undefined focus', { title: 't', body: 'b' }],
  ])('throws for %s and shows nothing', (_name, request) => {
    const show = vi.fn()
    expect(() => resolveNotifyNeedsYou(request as never, { show })).toThrow("'notify:needs-you'")
    expect(show).not.toHaveBeenCalled()
  })

  it('throws for a missing request', () => {
    expect(() => resolveNotifyNeedsYou(undefined as never, { show: vi.fn() })).toThrow("'notify:needs-you'")
  })

  it('accepts text of exactly the cap', () => {
    const show = vi.fn()
    resolveNotifyNeedsYou({ title: 'x'.repeat(MAX_NOTIFICATION_TEXT), body: 'b', focus: null }, { show })
    expect(show).toHaveBeenCalledOnce()
  })
})

describe('notify preferences channels', () => {
  const stored = { needsYou: true, sessions: false }
  const deps = () => ({ prefs: vi.fn(() => Promise.resolve(stored)), setPrefs: vi.fn((next: typeof stored) => Promise.resolve(next)) })

  it('reads the stored preferences', async () => {
    await expect(resolveNotifyPrefs(undefined, deps())).resolves.toEqual(stored)
  })

  it('rejects a payload on the read', () => {
    expect(() => resolveNotifyPrefs({} as never, deps())).toThrow("'notify:prefs' takes no payload")
  })

  it('saves two booleans and returns what was stored', async () => {
    const d = deps()
    await expect(resolveNotifyPrefsSet({ needsYou: false, sessions: true }, d)).resolves.toEqual({ needsYou: false, sessions: true })
    expect(d.setPrefs).toHaveBeenCalledWith({ needsYou: false, sessions: true })
  })

  it.each([
    ['a missing request', undefined],
    ['a non-boolean needsYou', { needsYou: 'yes', sessions: true }],
    ['a missing sessions', { needsYou: true }],
  ])('throws for %s and saves nothing', (_name, request) => {
    const d = deps()
    expect(() => resolveNotifyPrefsSet(request as never, d)).toThrow("'notify:prefs:set'")
    expect(d.setPrefs).not.toHaveBeenCalled()
  })

  it('drops an extra field instead of persisting it', async () => {
    const d = deps()
    await resolveNotifyPrefsSet({ needsYou: true, sessions: true, extra: 1 } as never, d)
    expect(d.setPrefs).toHaveBeenCalledWith({ needsYou: true, sessions: true })
  })
})

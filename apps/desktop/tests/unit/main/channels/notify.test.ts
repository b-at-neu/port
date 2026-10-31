import { describe, expect, it, vi } from 'vitest'
import { MAX_NOTIFICATION_TEXT, resolveNotifyNeedsYou } from '@/main/channels/notify'

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

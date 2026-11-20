import { describe, expect, it } from 'vitest'
import { assigneeView, detailPanelId, epicSummaryView, linkListView } from '@/renderer/backlog/detail'
import type { BacklogEpicSummary } from '@/types/backlog'

const link = (number: number, state = 'OPEN') => ({ number, title: `Ticket ${String(number)}`, url: `https://example.test/${String(number)}`, state })

describe('detailPanelId', () => {
  it('replaces every character outside the id-safe set', () => {
    expect(detailPanelId('owner/repo:name:45')).toBe('backlog-detail-owner-repo-name-45')
  })

  it('keeps letters, digits, underscores and dashes', () => {
    expect(detailPanelId('a_b-C9')).toBe('backlog-detail-a_b-C9')
  })
})

describe('linkListView', () => {
  it('carries the reason of a failed read', () => {
    expect(linkListView({ ok: false, reason: 'boom' })).toEqual({ kind: 'failed', reason: 'boom' })
  })

  it('reports none for an empty list', () => {
    expect(linkListView({ ok: true, items: [], total: 0 })).toEqual({ kind: 'none' })
  })

  it('flags closed items and keeps their order', () => {
    const view = linkListView({ ok: true, items: [link(43), link(40, 'CLOSED')], total: 2 })
    expect(view).toEqual({
      kind: 'links',
      items: [
        { number: 43, title: 'Ticket 43', url: 'https://example.test/43', closed: false },
        { number: 40, title: 'Ticket 40', url: 'https://example.test/40', closed: true },
      ],
      more: 0,
    })
  })

  it('counts the links the page did not hold', () => {
    const view = linkListView({ ok: true, items: [link(43), link(40)], total: 4 })
    expect(view).toMatchObject({ kind: 'links', more: 2 })
  })

  it('never reports a negative remainder', () => {
    const view = linkListView({ ok: true, items: [link(43), link(40)], total: 1 })
    expect(view).toMatchObject({ kind: 'links', more: 0 })
  })
})

describe('assigneeView', () => {
  it('is unassigned for an empty list', () => {
    expect(assigneeView([])).toEqual({ kind: 'unassigned' })
  })

  it('names one person', () => {
    expect(assigneeView(['bob'])).toEqual({ kind: 'people', text: 'bob' })
  })

  it('joins two people', () => {
    expect(assigneeView(['bob', 'alice'])).toEqual({ kind: 'people', text: 'bob, alice' })
  })
})

describe('epicSummaryView', () => {
  const child = (number: number) => ({ number, title: `Ticket ${String(number)}`, state: 'OPEN' as const, claimed: false, blockers: { ok: true as const, open: [], closed: [], shown: 0, total: 0 } })
  const ok = (overrides: Partial<Extract<BacklogEpicSummary, { ok: true }>> = {}): BacklogEpicSummary => ({
    ok: true,
    wavesMayShift: false,
    done: 1,
    inProgress: 2,
    open: 3,
    total: 6,
    canStart: [child(44), child(46)],
    truncated: null,
    uncertain: [],
    cycles: [],
    ...overrides,
  })

  it('keeps the counts and the can-start order, with each ticket linked beside the epic', () => {
    expect(epicSummaryView(ok(), 'https://github.com/acme/widgets/issues/41')).toEqual({
      ok: true,
      done: 1,
      total: 6,
      inProgress: 2,
      canStart: [
        { number: 44, title: 'Ticket 44', url: 'https://github.com/acme/widgets/issues/44' },
        { number: 46, title: 'Ticket 46', url: 'https://github.com/acme/widgets/issues/46' },
      ],
      truncated: null,
    })
  })

  it('passes truncation through', () => {
    expect(epicSummaryView(ok({ truncated: { shown: 50, total: 70 } }), 'u/1')).toMatchObject({ ok: true, truncated: { shown: 50, total: 70 } })
  })

  it('carries the reason of a failed read', () => {
    expect(epicSummaryView({ ok: false, reason: 'no sub-issues' }, 'u/1')).toEqual({ ok: false, reason: 'no sub-issues' })
  })
})

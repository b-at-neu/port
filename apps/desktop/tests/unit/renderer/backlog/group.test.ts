import { describe, expect, it } from 'vitest'
import type { BacklogQueryLike, BacklogResponse } from '@/types/backlog'
import { buildBacklogGroup, staleSinceAt } from '@/renderer/backlog/group'
import { BACKLOG_REPO_ID } from '../../../support/backlog-row'

const NO_LINKS = { ok: true, open: [], shown: 0, total: 0 } as const
const ITEM = { number: 47, title: 'Add dark mode', url: 'u47', createdAt: '2026-01-01T00:00:00Z', assignees: [], labels: [{ name: 'bug', color: 'd73a4a' }], subIssueCount: 0, blockers: NO_LINKS, blocking: NO_LINKS, parent: { ok: true, parent: null }, children: { ok: true, children: [], shown: 0, total: 0 } } as const

const OK_RESPONSE: Extract<BacklogResponse, { ok: true }> = {
  ok: true,
  items: [ITEM, { ...ITEM, number: 45, assignees: ['alice', 'octo-dev'], labels: [{ name: 'docs', color: null }] }],
  scanned: 2,
  total: 2,
  viewer: 'octo-dev',
  fetchedAt: '2026-01-02T00:00:00Z',
}

function query(overrides: Partial<BacklogQueryLike> = {}): BacklogQueryLike {
  return { status: 'success', data: undefined, isError: false, dataUpdatedAt: 0, ...overrides }
}

function loaded(data: BacklogResponse, filter?: Parameters<typeof buildBacklogGroup>[3]) {
  const group = buildBacklogGroup(BACKLOG_REPO_ID, 'acme/widgets', query({ data }), filter)
  if (group.kind !== 'loaded') throw new Error('expected loaded')
  return group
}

describe('buildBacklogGroup', () => {
  it.each([
    ['a pending query', query({ status: 'pending' }), 'loading'],
    ['a failed invoke with no data', query({ status: 'error' }), 'invoke-error'],
    ['an ok:false reply', query({ data: { ok: false, kind: 'unauthenticated', message: '', fetchedAt: '' } }), 'read-error'],
    ['an ok reply', query({ data: OK_RESPONSE }), 'loaded'],
  ] as const)('maps %s to %s', (_name, input, kind) => {
    expect(buildBacklogGroup(BACKLOG_REPO_ID, 'acme/widgets', input).kind).toBe(kind)
  })

  it('drops the viewer from the assignee line and flags truncation', () => {
    const group = loaded({ ...OK_RESPONSE, total: 50 })
    expect(group.items.map((row) => row.assignee)).toEqual([null, '@alice'])
    expect(group.truncatedNote).not.toBeNull()
    expect(loaded(OK_RESPONSE).truncatedNote).toBeNull()
  })

  it('filters items while totalCount and labelOptions stay unfiltered', () => {
    const group = loaded(OK_RESPONSE, { include: ['bug'], exclude: [] })
    expect(group.items.map((row) => row.number)).toEqual([47])
    expect(group.totalCount).toBe(2)
    expect(group.labelOptions.map((option) => [option.label.name, option.count, option.state])).toEqual([
      ['bug', 1, 'only'],
      ['docs', 1, 'any'],
    ])
  })
})

describe('staleSinceAt', () => {
  it.each([
    ['nothing errored', [query({ data: OK_RESPONSE })], null],
    ['an errored query with no retained data', [query({ isError: true })], null],
    ['the earliest errored-but-retained read', [query({ data: OK_RESPONSE, isError: true, dataUpdatedAt: 200 }), query({ data: OK_RESPONSE, isError: true, dataUpdatedAt: 100 })], 100],
  ])('is %s', (_name, queries, expected) => {
    expect(staleSinceAt(queries.map((q) => ({ query: q })))).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { BacklogResponse } from '../../../shared/backlog/types'
import { buildBacklogGroup, exactTime, relativeAge, staleSinceAt } from './group'
import type { BacklogQueryLike } from './group'

const REPO_ID = 'repo-a' as RepoId

function query(overrides: Partial<BacklogQueryLike> = {}): BacklogQueryLike {
  return { status: 'success', data: undefined, isError: false, dataUpdatedAt: 0, ...overrides }
}

const OK_RESPONSE: Extract<BacklogResponse, { ok: true }> = {
  ok: true,
  items: [
    { number: 47, title: 'Add dark mode', url: 'https://github.com/acme/widgets/issues/47', updatedAt: '2026-01-01T00:00:00Z', assignees: [] },
    { number: 45, title: 'Document retries', url: 'https://github.com/acme/widgets/issues/45', updatedAt: '2026-01-01T00:00:00Z', assignees: ['alice'] },
  ],
  scanned: 2,
  total: 2,
  viewer: 'octo-dev',
  fetchedAt: '2026-01-02T00:00:00Z',
}

describe('buildBacklogGroup', () => {
  it('reports loading while the query is pending', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ status: 'pending' }))
    expect(group.kind).toBe('loading')
  })

  it('reports an invoke error when the call itself failed with no prior data', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ status: 'error' }))
    expect(group.kind).toBe('invoke-error')
  })

  it('reports a read error for an ok:false response', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: { ok: false, kind: 'unauthenticated', message: '', fetchedAt: '' } }))
    expect(group.kind).toBe('read-error')
    if (group.kind === 'read-error') expect(group.message).toContain('gh auth login')
  })

  it('reports the loaded items, dropping the viewer from the assignee line', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: OK_RESPONSE }))
    expect(group.kind).toBe('loaded')
    if (group.kind !== 'loaded') return
    expect(group.items).toHaveLength(2)
    expect(group.items[1]?.assignee).toBe('@alice')
    expect(group.items[0]?.assignee).toBeNull()
    expect(group.truncatedNote).toBeNull()
  })

  it('reports a truncated note when total exceeds scanned', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: { ...OK_RESPONSE, total: 50 } }))
    expect(group.kind).toBe('loaded')
    if (group.kind === 'loaded') expect(group.truncatedNote).toContain('2')
  })

  it('never drops the viewer\'s own assignee off a claimable item silently — unassigned stays null', () => {
    const response = { ...OK_RESPONSE, items: [{ ...OK_RESPONSE.items[0]!, assignees: ['octo-dev'] }] }
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: response }))
    expect(group.kind).toBe('loaded')
    if (group.kind === 'loaded') expect(group.items[0]?.assignee).toBeNull()
  })
})

describe('staleSinceAt', () => {
  it('is null when nothing has an error', () => {
    expect(staleSinceAt([{ query: query({ data: OK_RESPONSE }) }])).toBeNull()
  })

  it('is null when the errored query has no retained data', () => {
    expect(staleSinceAt([{ query: query({ isError: true }) }])).toBeNull()
  })

  it('is the earliest dataUpdatedAt among errored-but-retained queries', () => {
    const groups = [{ query: query({ data: OK_RESPONSE, isError: true, dataUpdatedAt: 200 }) }, { query: query({ data: OK_RESPONSE, isError: true, dataUpdatedAt: 100 }) }]
    expect(staleSinceAt(groups)).toBe(100)
  })
})

describe('relativeAge/exactTime', () => {
  const now = new Date('2026-01-01T12:00:00Z')

  it('renders a recent age in minutes', () => {
    expect(relativeAge(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5m ago')
  })

  it('renders a day-scale age in days', () => {
    expect(relativeAge(new Date(now.getTime() - 50 * 60 * 60_000).toISOString(), now)).toBe('2d ago')
  })

  it('exactTime renders a locale string, not the raw ISO', () => {
    expect(exactTime('2026-01-01T12:00:00Z')).not.toBe('2026-01-01T12:00:00Z')
  })
})

import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogResponse } from '@/types/backlog'
import { buildBacklogGroup, staleSinceAt } from '@/renderer/backlog/group'
import type { BacklogQueryLike } from '@/types/backlog'

const REPO_ID = 'repo-a' as RepoId

function query(overrides: Partial<BacklogQueryLike> = {}): BacklogQueryLike {
  return { status: 'success', data: undefined, isError: false, dataUpdatedAt: 0, ...overrides }
}

const NO_LINKS = { ok: true, open: [], shown: 0, total: 0 } as const
const NO_PARENT = { ok: true, parent: null } as const
const NO_CHILDREN = { ok: true, children: [], shown: 0, total: 0 } as const
const CHILD_NO_LINKS = { ok: true, open: [], closed: [], shown: 0, total: 0 } as const

const OK_RESPONSE: Extract<BacklogResponse, { ok: true }> = {
  ok: true,
  items: [
    { number: 47, title: 'Add dark mode', url: 'https://github.com/acme/widgets/issues/47', createdAt: '2026-01-01T00:00:00Z', assignees: [], labels: [{ name: 'bug', color: 'd73a4a' }], subIssueCount: 0, blockers: NO_LINKS, blocking: NO_LINKS, parent: NO_PARENT, children: NO_CHILDREN },
    {
      number: 45,
      title: 'Document retries',
      url: 'https://github.com/acme/widgets/issues/45',
      createdAt: '2026-01-01T00:00:00Z',
      assignees: ['alice'],
      labels: [{ name: 'docs', color: null }],
      subIssueCount: 2,
      blockers: { ok: true, open: [{ number: 43, title: 'Rate-limit search', url: 'u43', state: 'OPEN' }], shown: 1, total: 1 },
      blocking: { ok: true, open: [{ number: 50, title: 'Ship it', url: 'u50', state: 'OPEN' }], shown: 1, total: 1 },
      parent: { ok: true, parent: { number: 41, title: 'Epic', state: 'OPEN' } },
      children: { ok: true, children: [{ number: 46, title: 'Child', state: 'OPEN', claimed: false, blockers: CHILD_NO_LINKS }], shown: 1, total: 1 },
    },
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

  it('passes labels and the sub-issue count through to each row', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: OK_RESPONSE }))
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.items[0]?.labels).toEqual([{ name: 'bug', color: 'd73a4a' }])
    expect(group.items[1]?.subIssueCount).toBe(2)
  })

  it('passes each row\'s parent, children and blocking through unchanged', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: OK_RESPONSE }))
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.items[1]?.parent).toEqual(OK_RESPONSE.items[1]?.parent)
    expect(group.items[1]?.children).toEqual(OK_RESPONSE.items[1]?.children)
    expect(group.items[1]?.blocking).toEqual(OK_RESPONSE.items[1]?.blocking)
  })

  it('passes each row\'s blockers through unchanged', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: OK_RESPONSE }))
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.items[0]?.blockers).toEqual({ ok: true, open: [], shown: 0, total: 0 })
    expect(group.items[1]?.blockers).toEqual(OK_RESPONSE.items[1]?.blockers)
  })

  it('applies the filter to items while totalCount and labelOptions stay unfiltered', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: OK_RESPONSE }), { include: ['bug'], exclude: [] })
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.items.map((row) => row.number)).toEqual([47])
    expect(group.totalCount).toBe(2)
    expect(group.labelOptions.map((option) => [option.label.name, option.count, option.state])).toEqual([
      ['bug', 1, 'only'],
      ['docs', 1, 'any'],
    ])
  })

  it('never drops the viewer\'s own assignee off a claimable item silently — unassigned stays null', () => {
    const response = { ...OK_RESPONSE, items: [{ ...OK_RESPONSE.items[0]!, assignees: ['octo-dev'] }] }
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: response }))
    expect(group.kind).toBe('loaded')
    if (group.kind === 'loaded') expect(group.items[0]?.assignee).toBeNull()
  })
})

function epicResponse(): Extract<BacklogResponse, { ok: true }> {
  const base = OK_RESPONSE.items[0]!
  const child = (number: number, blockedBy: number[], labels: { name: string; color: string | null }[]) => ({
    ...base,
    number,
    labels,
    parent: { ok: true, parent: { number: 41, title: 'Epic', state: 'OPEN' } } as const,
    blockers: { ok: true, open: blockedBy.map((n) => ({ number: n, title: `T${String(n)}`, url: '', state: 'OPEN' as const })), shown: blockedBy.length, total: blockedBy.length } as const,
  })
  const members = [
    { number: 42, title: 'A', state: 'OPEN' as const, claimed: false, blockers: CHILD_NO_LINKS },
    { number: 43, title: 'B', state: 'OPEN' as const, claimed: false, blockers: { ok: true, open: [{ number: 42, title: 'A', url: '', state: 'OPEN' as const }], closed: [], shown: 1, total: 1 } as const },
  ]
  return {
    ...OK_RESPONSE,
    items: [
      { ...base, number: 41, labels: [], subIssueCount: 2, children: { ok: true, children: members, shown: 2, total: 2 } },
      child(42, [], [{ name: 'bug', color: null }]),
      child(43, [42], []),
      { ...base, number: 50, labels: [{ name: 'bug', color: null }] },
    ],
    total: 4,
    scanned: 4,
  }
}

describe('buildBacklogGroup layout', () => {
  it('groups children under their epic, with the loose row after it', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: epicResponse() }))
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    const [first, second] = group.layout.entries
    expect(group.layout.entries.map((entry) => entry.kind)).toEqual(['epic', 'row'])
    if (first?.kind !== 'epic' || second?.kind !== 'row') throw new Error('expected an epic then a row')
    expect(first.group.epic.number).toBe(41)
    expect(first.group.waves.map((wave) => [wave.number, wave.rows.map((row) => row.number)])).toEqual([[1, [42]], [2, [43]]])
    expect(second.row.number).toBe(50)
  })

  it('keeps wave numbers when a filter hides a wave member', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: epicResponse() }), { include: ['bug'], exclude: [] })
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    const first = group.layout.entries[0]
    if (first?.kind !== 'epic') throw new Error('expected an epic first')
    expect(first.group.waves.map((wave) => [wave.number, wave.rows.map((row) => row.number)])).toEqual([[1, [42]]])
    expect(first.group.epic.number).toBe(41)
  })

  it('keeps a filtered-out epic as the header of its shown children', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: epicResponse() }), { include: ['bug'], exclude: [] })
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.items.map((row) => row.number)).toEqual([42, 50])
    expect(group.layout.entries.filter((entry) => entry.kind === 'epic')).toHaveLength(1)
  })

  it('projects createdAt into the row view', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: OK_RESPONSE }))
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.items[0]?.createdAt).toBe('2026-01-01T00:00:00Z')
  })

  it('makes every row of a repository with no epics a row entry', () => {
    const group = buildBacklogGroup(REPO_ID, 'acme/widgets', query({ data: { ...OK_RESPONSE, items: [OK_RESPONSE.items[0]!] } }))
    if (group.kind !== 'loaded') throw new Error('expected loaded')
    expect(group.layout.entries).toEqual(group.items.map((row) => ({ kind: 'row', row })))
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

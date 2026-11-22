import { describe, expect, it } from 'vitest'
import { exportDocument, groupIncidents } from '@/main/incidents/group'
import { INCIDENT_GROUP_ITEMS_LIMIT, type IncidentRecord } from '@/types/incidents'

function record(overrides: Partial<IncidentRecord>): IncidentRecord {
  return {
    v: 1,
    id: 'id',
    at: '2026-11-16T12:00:00.000Z',
    repo: 'o/r',
    number: 789,
    kind: 'pull-request',
    bucket: 'stale-snapshot',
    signature: 'stale-snapshot:needsHuman:head-moved',
    decision: { action: 'observe-zero-diff', detail: null, intended: null },
    inputs: {},
    outcome: { kind: 'applied' },
    related: { audit: [], tick: null },
    resolvedBy: null,
    ...overrides,
  }
}

describe('groupIncidents', () => {
  it('collapses a recurrence into the existing group instead of adding one', () => {
    const groups = groupIncidents([record({ id: 'a', number: 789, at: '2026-11-16T12:00:00.000Z' }), record({ id: 'b', number: 790, at: '2026-11-16T12:00:05.000Z' }), record({ id: 'c', number: 790, at: '2026-11-16T13:00:00.000Z' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ signature: 'stale-snapshot:needsHuman:head-moved', bucket: 'stale-snapshot', stage: 'needsHuman', condition: 'head-moved', count: 3, firstAt: '2026-11-16T12:00:00.000Z', lastAt: '2026-11-16T13:00:00.000Z' })
    expect(groups[0]?.items).toEqual([
      { repo: 'o/r', kind: 'pull-request', number: 789 },
      { repo: 'o/r', kind: 'pull-request', number: 790 },
    ])
  })

  it('keeps different signatures apart and sorts the newest group first', () => {
    const groups = groupIncidents([record({ at: '2026-11-16T12:00:00.000Z' }), record({ bucket: 'escalation', signature: 'escalation:needsHuman:budget', at: '2026-11-17T12:00:00.000Z' })])
    expect(groups.map((group) => group.signature)).toEqual(['escalation:needsHuman:budget', 'stale-snapshot:needsHuman:head-moved'])
  })

  it('caps the ticket list and counts what it dropped', () => {
    const many = Array.from({ length: INCIDENT_GROUP_ITEMS_LIMIT + 3 }, (_, index) => record({ number: index + 1 }))
    const [group] = groupIncidents(many)
    expect(group?.items).toHaveLength(INCIDENT_GROUP_ITEMS_LIMIT)
    expect(group?.droppedItems).toBe(3)
    expect(group?.count).toBe(INCIDENT_GROUP_ITEMS_LIMIT + 3)
  })
})

describe('exportDocument', () => {
  it('is the grouped view with the read\'s own notes', () => {
    const groups = groupIncidents([record({})])
    const document = exportDocument(groups, { malformed: 2, pruned: { count: 4, through: '2026-08-01T00:00:00.000Z' } }, 'o/r', new Date('2026-11-17T00:00:00.000Z'))
    expect(document).toEqual({ v: 1, exportedAt: '2026-11-17T00:00:00.000Z', repo: 'o/r', groups, malformed: 2, pruned: { count: 4, through: '2026-08-01T00:00:00.000Z' } })
  })
})

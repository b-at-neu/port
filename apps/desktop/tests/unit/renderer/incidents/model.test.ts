import { describe, expect, it } from 'vitest'
import { BUCKET_TONE, groupRows, recordRow } from '@/renderer/incidents/model'
import { BUCKET_LABEL, exportedToast, failureCopy, footnotes } from '@/renderer/incidents/copy'
import { INCIDENT_BUCKETS, type IncidentGroup, type IncidentRecord } from '@/types/incidents'

const GROUP: IncidentGroup = {
  signature: 'stale-snapshot:needsHuman:head-moved',
  bucket: 'stale-snapshot',
  stage: 'needsHuman',
  condition: 'head-moved',
  count: 2,
  firstAt: '2026-11-16T12:00:00.000Z',
  lastAt: '2026-11-16T12:00:05.000Z',
  items: [
    { repo: 'b-at-neu/port', kind: 'pull-request', number: 789 },
    { repo: 'b-at-neu/port', kind: 'pull-request', number: 790 },
  ],
  droppedItems: 0,
}

function record(inputs: IncidentRecord['inputs'], outcome: IncidentRecord['outcome'] = { kind: 'applied' }): IncidentRecord {
  return { v: 1, id: 'r1', at: '2026-11-16T12:00:05.000Z', repo: 'b-at-neu/port', number: 790, kind: 'pull-request', bucket: 'stale-snapshot', signature: GROUP.signature, decision: { action: 'observe-zero-diff', detail: null, intended: null }, inputs, outcome, related: { audit: [], tick: null }, resolvedBy: null }
}

describe('groupRows', () => {
  it('names the bucket, its tone, the condition and the affected tickets with their repository', () => {
    expect(groupRows([GROUP])).toEqual([{ signature: GROUP.signature, bucket: 'Stale snapshot', tone: 'danger', condition: 'head-moved', count: 2, firstAt: GROUP.firstAt, lastAt: GROUP.lastAt, tickets: '#789 #790 b-at-neu/port' }])
  })

  it('says how many tickets were dropped from the list', () => {
    expect(groupRows([{ ...GROUP, droppedItems: 4 }])[0]?.tickets).toBe('#789 #790 +4 more b-at-neu/port')
  })

  it('gives every bucket a label and a tone', () => {
    for (const bucket of INCIDENT_BUCKETS) {
      expect(BUCKET_LABEL[bucket]).not.toBe('')
      expect(BUCKET_TONE[bucket]).toBeDefined()
    }
  })
})

describe('recordRow', () => {
  it('shows both heads only when the inputs carry both', () => {
    expect(recordRow(record({ observedHead: '4a05a87c1d2e', writeHead: '9c1e2f0a7b6d' })).heads).toBe('4a05a87 → 9c1e2f0')
    expect(recordRow(record({ observedHead: '4a05a87c1d2e' })).heads).toBeNull()
    expect(recordRow(record({})).heads).toBeNull()
  })

  it('names the ticket, the decision and the outcome', () => {
    expect(recordRow(record({}))).toMatchObject({ ticket: '#790', action: 'observe-zero-diff', outcome: 'applied' })
    expect(recordRow(record({}, null)).outcome).toBe('not written')
  })
})

describe('copy', () => {
  it('states what a failed read means', () => {
    expect(failureCopy('too-large', '')).toContain('incidents.jsonl')
    expect(failureCopy('io', 'EIO')).toContain('EIO')
  })

  it('footnotes unreadable lines and dropped older incidents', () => {
    expect(footnotes(1, null)).toHaveLength(1)
    expect(footnotes(1, null)[0]).toContain('1')
    expect(footnotes(0, { count: 3, through: 't' })[0]).toContain('3')
    expect(footnotes(0, null)).toEqual([])
  })

  it('names the exported file, not its folder', () => {
    const toast = exportedToast('/home/op/port-incidents-2026-11-17.json')
    expect(toast).toContain('port-incidents-2026-11-17.json')
    expect(toast).not.toContain('/home/op')
  })
})

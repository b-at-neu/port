// Fixture mode's own canned incident log: three groups, one of them a stale-snapshot group two pull requests share.
import type { IpcMap } from '@/types/ipc'
import type { FixtureScenario } from '@/types/fixtures'
import type { IncidentBucket, IncidentExportResult, IncidentGroup, IncidentGroupsRead, IncidentListRead, IncidentRecord } from '@/types/incidents'

const REPO = 'acme/widgets'

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function record(now: Date, minutes: number, number: number, bucket: IncidentBucket, stage: string, condition: string, action: string, inputs: IncidentRecord['inputs'], outcome: string): IncidentRecord {
  return {
    v: 1,
    id: `fixture-${String(number)}-${String(minutes)}`,
    at: minutesAgo(now, minutes),
    repo: REPO,
    number,
    kind: 'pull-request',
    bucket,
    signature: `${bucket}:${stage}:${condition}`,
    decision: { action, detail: null, intended: null },
    inputs,
    outcome: { kind: outcome },
    related: { audit: [], tick: null },
    resolvedBy: null,
  }
}

function cannedRecords(now: Date): readonly IncidentRecord[] {
  return [
    record(now, 1500, 790, 'stale-snapshot', 'needsHuman', 'head-moved', 'observe-zero-diff', { observedHead: '4a05a87c1d2e3f40', writeHead: '9c1e2f0a7b6d5e4c' }, 'applied'),
    record(now, 1490, 789, 'stale-snapshot', 'needsHuman', 'head-moved', 'observe-refresh-stuck', { observedHead: 'f19c6d5a0b1c2d3e', writeHead: 'a3b4c5d6e7f80912' }, 'applied'),
    record(now, 300, 41, 'network-interrupt', 'impl', 'network', 'stage-ended', { agent: 'impl' }, 'interrupted'),
    record(now, 45, 41, 'network-interrupt', 'impl', 'network', 'stage-ended', { agent: 'impl' }, 'interrupted'),
    record(now, 20, 38, 'refused-write', 'needsHuman', 'precondition-failed', 'observe-cycle-cap', { precondition: { present: ['needsRevision'] } }, 'precondition-failed'),
  ]
}

function recordsFor(now: Date, scenario: FixtureScenario): readonly IncidentRecord[] {
  return scenario === 'empty' || scenario === 'unregistered' ? [] : cannedRecords(now)
}

const FAILURE = { ok: false, kind: 'io', message: 'EIO: i/o error, read' } as const

function cannedGroups(now: Date): readonly IncidentGroup[] {
  const item = (number: number, kind: IncidentGroup['items'][number]['kind']): IncidentGroup['items'][number] => ({ repo: REPO, kind, number })
  return [
    { signature: 'refused-write:needsHuman:precondition-failed', bucket: 'refused-write', stage: 'needsHuman', condition: 'precondition-failed', count: 1, firstAt: minutesAgo(now, 20), lastAt: minutesAgo(now, 20), items: [item(38, 'pull-request')], droppedItems: 0 },
    { signature: 'network-interrupt:impl:network', bucket: 'network-interrupt', stage: 'impl', condition: 'network', count: 2, firstAt: minutesAgo(now, 300), lastAt: minutesAgo(now, 45), items: [item(41, 'pull-request')], droppedItems: 0 },
    { signature: 'stale-snapshot:needsHuman:head-moved', bucket: 'stale-snapshot', stage: 'needsHuman', condition: 'head-moved', count: 2, firstAt: minutesAgo(now, 1500), lastAt: minutesAgo(now, 1490), items: [item(790, 'pull-request'), item(789, 'pull-request')], droppedItems: 0 },
  ]
}

export function fixtureIncidentGroups(now: Date, scenario: FixtureScenario): IncidentGroupsRead {
  if (scenario === 'failing') return { ...FAILURE, readAt: now.toISOString() }
  return { ok: true, groups: scenario === 'empty' || scenario === 'unregistered' ? [] : cannedGroups(now), malformed: 0, pruned: null, readAt: now.toISOString() }
}

export function fixtureIncidentList(now: Date, scenario: FixtureScenario, request: IpcMap['incidents:list']['request']): IncidentListRead {
  if (scenario === 'failing') return { ...FAILURE, readAt: now.toISOString() }
  return { ok: true, records: recordsFor(now, scenario).filter((entry) => entry.signature === request.signature).reverse(), readAt: now.toISOString() }
}

export function fixtureIncidentExport(): IncidentExportResult {
  return { ok: false, kind: 'cancelled' }
}

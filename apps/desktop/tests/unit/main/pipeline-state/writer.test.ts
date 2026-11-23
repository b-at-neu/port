import { describe, expect, it, vi } from 'vitest'
import { itemKey, recordMirror, transition, viewOf, withItem } from '@/main/pipeline-state/model'
import { createStateWriter } from '@/main/pipeline-state/writer'
import type { ReadyEntry } from '@/types/actions'
import type { OwnershipRead } from '@/types/dispatch'
import type { ResolvedItem } from '@/types/github'
import type { MirrorFailure, PipelineStateStore, RepoRecord, StoredItem } from '@/types/pipeline-state'
import type { IncidentDraft, IncidentIntent, RecordIncident } from '@/types/incidents'
import type { ApplyLabelsParams, AuditEntry, LabelAuditEntry, LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { resolveDisplayVocabulary, type MirrorVocabulary } from '@/utils/labels/display'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo-a' as RepoId
const VOCABULARY = resolveVocabulary({})
const DISPLAY: MirrorVocabulary = { kind: 'display', labels: resolveDisplayVocabulary({}) }
const LEGACY: MirrorVocabulary = { kind: 'legacy' }
const NOW = () => new Date('2026-01-01T00:00:00.000Z')

function stored(overrides: Partial<StoredItem> = {}): StoredItem {
  return { kind: 'issue', number: 7, keys: ['planApproved'], marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: '2026-01-01T00:00:00.000Z', issue: null, mirrorFailure: null, ...overrides }
}

function resolved(number: number, kind: 'issue' | 'pull-request', labels: readonly string[], overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return { number, kind, state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels, assignees: ['op'], headRefName: kind === 'pull-request' ? '7-the-fix' : null, author: null, ...overrides }
}

function request(overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest {
  return {
    repoId: REPO,
    repo: 'o/a',
    kind: 'issue',
    number: 7,
    vocabulary: VOCABULARY,
    mirror: DISPLAY,
    add: ['inProgress'],
    remove: ['planApproved'],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: ['planApproved'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
    action: 'stage-claim',
    ...overrides,
  }
}

interface RigOptions {
  readonly items?: readonly StoredItem[]
  readonly view?: 'unseeded' | 'store'
  readonly githubLabels?: Readonly<Record<number, readonly string[]>>
  readonly kinds?: Readonly<Record<number, 'issue' | 'pull-request'>>
  readonly outcomes?: Readonly<Record<number, WriteOutcome>>
  readonly ownership?: OwnershipRead['kind']
  readonly persistFails?: boolean
  readonly incidentFails?: boolean
  readonly headRefOid?: string
}

function rig(options: RigOptions = {}) {
  const audits: AuditEntry[] = []
  const incidents: IncidentDraft[] = []
  const recordIncident: RecordIncident = (draft) => (options.incidentFails === true ? Promise.reject(new Error('disk full')) : Promise.resolve(void incidents.push(draft)))
  const writes: ApplyLabelsParams[] = []
  const reads: number[][] = []
  const items = options.items ?? [stored()]
  let record: RepoRecord = { seededAt: 't', items: Object.fromEntries(items.map((item) => [itemKey(item.kind, item.number), item])) }
  const store = {
    view: () => (options.view === 'unseeded' ? { kind: 'unseeded' as const } : viewOf(record)),
    transition: vi.fn((_id: RepoId, ref: { kind: 'issue' | 'pull-request'; number: number }, input: Parameters<PipelineStateStore['transition']>[2]) => {
      if (options.persistFails === true) return Promise.resolve({ ok: false as const, reason: 'persist-failed' as const, message: 'disk full' })
      const next = transition(record, ref, input)
      if (!next.ok) return Promise.resolve(next)
      record = withItem(record, next.item)
      return Promise.resolve({ ok: true as const, changed: next.changed })
    }),
    recordMirror: vi.fn((_id: RepoId, ref: { kind: 'issue' | 'pull-request'; number: number }, failure: MirrorFailure | null) => {
      record = recordMirror(record, ref, failure)
      return Promise.resolve()
    }),
  }
  const applyLabels = vi.fn((params: ApplyLabelsParams): Promise<WriteOutcome> => {
    writes.push(params)
    return Promise.resolve(options.outcomes?.[params.number] ?? { kind: 'applied', argv: ['edit', String(params.number)] })
  })
  const ownership: OwnershipRead = options.ownership === 'unreadable' ? { kind: 'unreadable', message: 'bad', path: 'p', readAt: 'r' } : { kind: 'app', since: 's', path: 'p', readAt: 'r' }
  const writer = createStateWriter({
    store: store as unknown as PipelineStateStore,
    applyLabels,
    readOwnership: () => Promise.resolve(ownership),
    fetchItemsByNumber: ({ numbers }) => {
      reads.push([...numbers])
      return Promise.resolve({ ok: true, resolved: numbers.map((n) => resolved(n, options.kinds?.[n] ?? 'issue', options.githubLabels?.[n] ?? [], options.headRefOid === undefined ? {} : { headRefOid: options.headRefOid })), unavailable: [], fetchedAt: 'r' })
    },
    appendAudit: (_dir, entry) => Promise.resolve(void audits.push(entry)),
    recordIncident,
    newId: () => 'write-1',
    now: NOW,
  })
  return { ...writer, store, applyLabels, writes, reads, audits, incidents, record: () => record }
}

const run = (r: ReturnType<typeof rig>, req: LabelWriteRequest = request()): Promise<WriteOutcome> => r.writeState({ request: req, repoRoot: '/repo', auditDir: '/audit' })

describe('writeState — the full-state mirror', () => {
  it('commits the store, then writes the whole display set for the post-transition state', async () => {
    const r = rig({ githubLabels: { 7: ['port', 'planning'] } })
    expect(await run(r)).toMatchObject({ kind: 'applied' })
    expect(r.store.transition).toHaveBeenCalledWith(REPO, { kind: 'issue', number: 7 }, expect.objectContaining({ add: ['inProgress'], remove: ['planApproved'], expect: { present: ['planApproved'], absent: [] }, action: 'stage-claim' }))
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]).toMatchObject({ number: 7, addNames: ['implementing'], removeNames: ['planning'], action: 'stage-claim' })
  })

  it('removes a state label added by hand and restores a removed port label', async () => {
    const r = rig({ githubLabels: { 7: ['approved', 'revising'] } })
    await run(r)
    expect(r.writes[0]).toMatchObject({ addNames: ['port', 'implementing'] })
    expect([...(r.writes[0]?.removeNames ?? [])].sort()).toEqual(['approved', 'revising'])
  })

  it('never touches a label outside the vocabulary', async () => {
    const r = rig({ githubLabels: { 7: ['port', 'implementing', 'bug'] } })
    await run(r)
    expect(r.writes[0]).toMatchObject({ addNames: [], removeNames: [] })
  })

  it('writes the store\'s full 17-key set for a legacy repository, so a hand-added label is gone', async () => {
    const r = rig({ githubLabels: { 7: ['claude', 'plan approved', 'ready'] } })
    await run(r, request({ mirror: LEGACY }))
    expect(r.writes[0]?.addNames).toEqual(['in progress'])
    expect([...(r.writes[0]?.removeNames ?? [])].sort()).toEqual(['plan approved', 'ready'])
  })

  it('shows needs you with the state at a gate', async () => {
    const r = rig({ items: [stored({ keys: ['planning'] })], githubLabels: { 7: ['port', 'planning'] } })
    await run(r, request({ add: ['planReview'], remove: ['planning'], expect: { present: ['planning'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.writes[0]).toMatchObject({ addNames: ['needs you'], removeNames: [] })
  })

  it('carries the request\'s assignee changes on the target write', async () => {
    const r = rig()
    await run(r, request({ addAssignees: ['op'], removeAssignees: ['other'], expect: { present: ['planApproved'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.writes[0]).toMatchObject({ addAssignees: ['op'], removeAssignees: ['other'] })
  })
})

describe('writeState — outcomes', () => {
  it('reports mirror-failed and records the failure on the item when the label write fails, without undoing the state', async () => {
    const failed: WriteOutcome = { kind: 'write-failed', classification: 'network', stderr: 'offline', reread: null }
    const r = rig({ outcomes: { 7: failed } })
    expect(await run(r)).toEqual({ kind: 'mirror-failed', mirror: failed })
    expect(r.store.transition).toHaveBeenCalledTimes(1)
    expect(r.record().items['issue:7']?.mirrorFailure).toEqual({ at: NOW().toISOString(), outcome: failed })
  })

  it('clears a recorded failure once the write lands', async () => {
    const failure: MirrorFailure = { at: 't', outcome: { kind: 'item-unavailable' } }
    const r = rig({ items: [stored({ mirrorFailure: failure })] })
    await run(r)
    expect(r.record().items['issue:7']?.mirrorFailure).toBeNull()
  })

  it('refuses with the stored names, expected against observed, and writes no label, when the store disagrees', async () => {
    const r = rig()
    const outcome = await run(r, request({ expect: { present: ['ready'], absent: [], assignees: { kind: 'any' } } }))
    expect(outcome).toMatchObject({ kind: 'precondition-failed', conflict: { expected: ['ready'], observed: ['claude', 'plan approved'] } })
    expect(r.applyLabels).not.toHaveBeenCalled()
    expect((r.audits[0] as LabelAuditEntry).result.kind).toBe('precondition-failed')
  })

  it('reports state-unsaved, nothing changed, when the store cannot persist', async () => {
    const r = rig({ persistFails: true })
    expect(await run(r)).toEqual({ kind: 'state-unsaved', message: 'disk full' })
    expect(r.applyLabels).not.toHaveBeenCalled()
  })

  it('refuses on the assignee half, from GitHub, before the store is touched', async () => {
    const r = rig()
    const outcome = await run(r, request({ expect: { present: ['planApproved'], absent: [], assignees: { kind: 'exactly', logins: ['someone-else'] } } }))
    expect(outcome).toMatchObject({ kind: 'precondition-failed', conflict: { expected: ['someone-else'], observed: ['op'] } })
    expect(r.store.transition).not.toHaveBeenCalled()
  })

  it('refuses a repository whose state is not loaded yet, with no write and no store change', async () => {
    const r = rig({ view: 'unseeded' })
    expect(await run(r)).toEqual({ kind: 'state-unsaved', message: "port hasn't loaded this repository's pipeline state yet" })
    expect(r.store.transition).not.toHaveBeenCalled()
    expect(r.applyLabels).not.toHaveBeenCalled()
  })

  it('refuses unreadable ownership, audited, with no store change and no label write', async () => {
    const r = rig({ ownership: 'unreadable' })
    expect((await run(r)).kind).toBe('ownership-unreadable')
    expect(r.store.transition).not.toHaveBeenCalled()
    expect(r.applyLabels).not.toHaveBeenCalled()
    expect(r.audits).toHaveLength(1)
  })

  it('reports an unresolvable key, audited, before touching the store', async () => {
    const r = rig()
    const withoutInProgress = { ...VOCABULARY, labels: VOCABULARY.labels.filter((label) => label.key !== 'inProgress') }
    expect(await run(r, request({ vocabulary: withoutInProgress }))).toEqual({ kind: 'unresolvable-label', keys: ['inProgress'] })
    expect(r.store.transition).not.toHaveBeenCalled()
    expect(r.audits).toHaveLength(1)
  })
})

describe('writeState — the counterpart', () => {
  const pr = stored({ kind: 'pull-request', number: 9, keys: ['readyForReview'], issue: 7 })
  const ticket = stored({ keys: ['prOpened'] })

  it('re-mirrors the ticket of a pull request in the same call, showing the pull request\'s state', async () => {
    const r = rig({ items: [ticket, pr], kinds: { 9: 'pull-request' }, githubLabels: { 7: ['port', 'implementing'], 9: ['port', 'reviewing'] } })
    await run(r, request({ kind: 'pull-request', number: 9, add: ['needsRevision'], remove: ['readyForReview'], expect: { present: ['readyForReview'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.writes.map((write) => [write.number, write.addNames, write.removeNames])).toEqual([
      [9, ['revising'], ['reviewing']],
      [7, ['revising'], ['implementing']],
    ])
  })

  it('skips the counterpart when its labels already match', async () => {
    const r = rig({ items: [ticket, pr], kinds: { 9: 'pull-request' }, githubLabels: { 7: ['port', 'revising'], 9: ['port', 'reviewing'] } })
    await run(r, request({ kind: 'pull-request', number: 9, add: ['needsRevision'], remove: ['readyForReview'], expect: { present: ['readyForReview'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.writes.map((write) => write.number)).toEqual([9])
  })

  it('records a counterpart failure but returns the target\'s outcome', async () => {
    const failed: WriteOutcome = { kind: 'write-failed', classification: 'network', stderr: 'offline', reread: null }
    const r = rig({ items: [ticket, pr], kinds: { 9: 'pull-request' }, githubLabels: { 7: ['port', 'implementing'], 9: ['port', 'reviewing'] }, outcomes: { 7: failed } })
    const outcome = await run(r, request({ kind: 'pull-request', number: 9, add: ['needsRevision'], remove: ['readyForReview'], expect: { present: ['readyForReview'], absent: [], assignees: { kind: 'any' } } }))
    expect(outcome.kind).toBe('applied')
    expect(r.record().items['issue:7']?.mirrorFailure?.outcome).toEqual(failed)
    expect(r.record().items['pull-request:9']?.mirrorFailure).toBeNull()
  })

  it('learns a pull request\'s ticket from its branch and reads the ticket in a second call', async () => {
    const fresh = stored({ kind: 'pull-request', number: 9, keys: [], issue: null })
    const r = rig({ items: [ticket, fresh], kinds: { 9: 'pull-request' }, githubLabels: { 7: ['port', 'implementing'], 9: [] } })
    await run(r, request({ kind: 'pull-request', number: 9, add: ['readyForReview'], remove: [], expect: { present: [], absent: [], assignees: { kind: 'any' } } }))
    expect(r.record().items['pull-request:9']?.issue).toBe(7)
    expect(r.reads).toEqual([[9], [7]])
    expect(r.writes.map((write) => write.number)).toEqual([9, 7])
  })

  it('writes a ticket write\'s pull request when its labels have drifted', async () => {
    const r = rig({ items: [stored({ keys: ['prOpened'] }), pr], kinds: { 9: 'pull-request' }, githubLabels: { 7: ['port', 'implementing'], 9: ['approved'] } })
    await run(r, request({ add: [], remove: [], expect: { present: ['prOpened'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.reads[0]).toEqual([7, 9])
    expect(r.writes.map((write) => [write.number, write.addNames])).toEqual([
      [7, ['reviewing']],
      [9, ['port', 'reviewing']],
    ])
  })

  it('never re-mirrors a counterpart for a legacy repository', async () => {
    const r = rig({ items: [ticket, pr], kinds: { 9: 'pull-request' } })
    await run(r, request({ mirror: LEGACY, kind: 'pull-request', number: 9, add: ['needsRevision'], remove: ['readyForReview'], expect: { present: ['readyForReview'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.writes.map((write) => write.number)).toEqual([9])
  })
})

describe('mirrorItem', () => {
  const entry = { id: REPO, path: '/repo', config: { repo: 'o/a', vocabulary: VOCABULARY } } as unknown as ReadyEntry

  it('writes the terminal state of a merged item without a store transition', async () => {
    const r = rig({ items: [stored({ keys: ['prOpened'] })], githubLabels: { 7: ['port', 'implementing'] } })
    // a legacy entry keeps the stored keys with approved in place of the in-flight and trigger ones
    const outcome = await r.mirrorItem({ entry, ref: { kind: 'issue', number: 7 }, action: 'mirror-merged', auditDir: '/audit', mode: 'merged' })
    expect(outcome.kind).toBe('applied')
    expect(r.store.transition).not.toHaveBeenCalled()
    expect(r.writes[0]).toMatchObject({ action: 'mirror-merged' })
  })

  it('records a failed retry and reports the outcome', async () => {
    const failed: WriteOutcome = { kind: 'write-failed', classification: 'unknown', stderr: "label 'reviewing' not found", reread: null }
    const r = rig({ outcomes: { 7: failed } })
    expect(await r.mirrorItem({ entry, ref: { kind: 'issue', number: 7 }, action: 'mirror-retry', auditDir: '/audit', mode: 'state' })).toEqual(failed)
    expect(r.record().items['issue:7']?.mirrorFailure?.outcome).toEqual(failed)
  })

  it('reports an item the store does not hold as unavailable without writing', async () => {
    const r = rig()
    expect(await r.mirrorItem({ entry, ref: { kind: 'issue', number: 99 }, action: 'mirror-retry', auditDir: '/audit', mode: 'state' })).toEqual({ kind: 'item-unavailable' })
    expect(r.applyLabels).not.toHaveBeenCalled()
  })
})

const INTENT: IncidentIntent = {
  bucket: 'duplicate-head',
  stage: 'needsHuman',
  condition: 'zero-diff',
  decision: { action: 'observe-zero-diff', detail: 'zero-diff', intended: null },
  inputs: { observedHead: 'old-head', snapshotAt: 'tick-1' },
}

describe('writeState — incidents', () => {
  it('records the intent as raised when the head read at write time is the one it observed', async () => {
    const r = rig({ headRefOid: 'old-head' })
    await run(r, request({ incident: INTENT }))
    expect(r.incidents).toHaveLength(1)
    expect(r.incidents[0]).toMatchObject({ bucket: 'duplicate-head', stage: 'needsHuman', condition: 'zero-diff', repo: 'o/a', number: 7, outcome: { kind: 'applied' }, related: { audit: ['write-1'], tick: 'tick-1' } })
    expect(r.incidents[0]?.inputs).toMatchObject({ observedHead: 'old-head', writeHead: 'old-head' })
  })

  it('moves the incident to stale-snapshot, carrying both heads, when the head moved since the decision', async () => {
    const r = rig({ headRefOid: 'new-head' })
    await run(r, request({ incident: INTENT }))
    expect(r.incidents[0]).toMatchObject({ bucket: 'stale-snapshot', stage: 'needsHuman', condition: 'head-moved', decision: { action: 'observe-zero-diff', intended: 'duplicate-head' } })
    expect(r.incidents[0]?.inputs).toMatchObject({ observedHead: 'old-head', writeHead: 'new-head' })
  })

  it('records a refused write that has no intent of its own', async () => {
    const r = rig({ ownership: 'unreadable' })
    expect(await run(r)).toMatchObject({ kind: 'ownership-unreadable' })
    expect(r.incidents).toHaveLength(1)
    expect(r.incidents[0]).toMatchObject({ bucket: 'refused-write', stage: 'inProgress', condition: 'ownership-unreadable', outcome: { kind: 'ownership-unreadable' } })
  })

  it('records nothing for a write that landed with no intent', async () => {
    const r = rig()
    await run(r)
    expect(r.incidents).toHaveLength(0)
  })

  it('stamps the incident and the audit entry with the same write id', async () => {
    const r = rig({ headRefOid: 'old-head' })
    await run(r, request({ incident: INTENT }))
    expect(r.writes[0]?.writeId).toBe('write-1')
    expect(r.incidents[0]?.related.audit).toEqual(['write-1'])
  })

  it('leaves every outcome unchanged when recording the incident fails', async () => {
    const ok = rig({ incidentFails: true })
    expect(await run(ok, request({ incident: INTENT }))).toMatchObject({ kind: 'applied' })
    const refused = rig({ incidentFails: true, ownership: 'unreadable' })
    expect(await run(refused)).toMatchObject({ kind: 'ownership-unreadable' })
  })
})

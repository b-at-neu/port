// Replays of the cases that motivated the log, through the real raising code and the real writer.
import { describe, expect, it } from 'vitest'
import { applyObservation } from '@/main/pipeline/operator/observe'
import { groupIncidents } from '@/main/pipeline/incidents/group'
import { createIncidentLog } from '@/main/pipeline/incidents/log'
import { draftOf, noRelated, observationIntent, stageHandbackIntent } from '@/main/pipeline/incidents/raise'
import type { WriteObservation } from '@/types/dispatch'
import type { IncidentDraft } from '@/types/incidents'
import { createFakePlatform } from '../../../../support/fake-platform'
import { ENTRY, item, writerRig } from './fixtures'

async function observe(number: number, headAtDecision: string, headAtWrite: string, observation: WriteObservation) {
  const rig = await writerRig({ number, writeHead: headAtWrite })
  await applyObservation(rig.ctx, { entry: ENTRY, item: item({ number, headRefOid: headAtDecision }), observation, snapshotAt: '2026-11-16T11:59:00.000Z', auditDir: rig.auditDir, scratchDir: rig.auditDir })
  return rig.incidents
}

describe('#789 — a refresh pushed, then an escalation computed from the pre-push head', () => {
  it('records one stale-snapshot incident carrying both head SHAs', async () => {
    const incidents = await observe(789, 'f19c6d5', 'a7e3b21', { kind: 'refresh-stuck', number: 789, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'f19c6d5', count: 2 })
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ bucket: 'stale-snapshot', stage: 'needsHuman', condition: 'head-moved', number: 789, decision: { action: 'observe-refresh-stuck', detail: 'refresh-stuck', intended: 'escalation' }, related: { audit: [expect.any(String)], tick: '2026-11-16T11:59:00.000Z' } })
    expect(incidents[0]?.inputs).toMatchObject({ observedHead: 'f19c6d5', writeHead: 'a7e3b21' })
  })
})

describe('#790 — a revise push, then a zero-diff escalation five seconds later', () => {
  it('groups with #789 under one signature', async () => {
    const first = await observe(789, 'f19c6d5', 'a7e3b21', { kind: 'refresh-stuck', number: 789, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'f19c6d5', count: 2 })
    const second = await observe(790, '4a05a87', '9c1e2f0', { kind: 'zero-diff', number: 790, itemKind: 'pull-request', count: 2, headRefOid: '4a05a87' })
    expect(second[0]).toMatchObject({ bucket: 'stale-snapshot', condition: 'head-moved', decision: { intended: 'duplicate-head' } })

    const log = createIncidentLog(createFakePlatform())
    for (const draft of [...first, ...second]) await log.record(draft)
    const read = await log.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const groups = groupIncidents(read.records)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ signature: 'stale-snapshot:needsHuman:head-moved', count: 2 })
    expect(groups[0]?.items.map((entry) => entry.number)).toEqual([789, 790])
  })
})

describe('the 2026-11-16 sleep case', () => {
  it('records incidents for #779, #749 and #780', () => {
    const ref = (number: number, kind: 'issue' | 'pull-request') => ({ repo: 'o/r', kind, number })
    const reset = (number: number): WriteObservation => ({ kind: 'liveness-reset', number, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'planApproved' })
    const zeroDiff: WriteObservation = { kind: 'zero-diff', number: 779, itemKind: 'pull-request', count: 2, headRefOid: 'f19c6d5' }
    const drafts: IncidentDraft[] = []
    const raise = (intent: ReturnType<typeof observationIntent>, number: number, kind: 'issue' | 'pull-request') => {
      if (intent !== null) drafts.push(draftOf(intent, ref(number, kind), { kind: 'applied' }, noRelated()))
    }
    raise(observationIntent(reset(779), item({ kind: 'issue', number: 779 }), { add: ['planApproved'], remove: ['inProgress'], action: 'observe-liveness-reset' }, null), 779, 'issue')
    raise(observationIntent(zeroDiff, item({ number: 779 }), { add: ['needsHuman'], remove: ['readyForReview'], action: 'observe-zero-diff' }, null), 779, 'pull-request')
    raise(observationIntent(reset(749), item({ kind: 'issue', number: 749 }), { add: ['planApproved'], remove: ['inProgress'], action: 'observe-liveness-reset' }, null), 749, 'issue')
    const blocked = { key: 'blocked', action: 'stage-handback-blocked' } as const
    const existing = stageHandbackIntent(blocked, 'impl', 749, item({ kind: 'issue', number: 749, closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-the-fix' }] }), null)
    if (existing !== null) drafts.push(draftOf(existing, ref(749, 'issue'), { kind: 'applied' }, noRelated()))

    expect(drafts.map((draft) => [draft.number, draft.bucket])).toEqual([
      [779, 'liveness-reset'],
      [779, 'duplicate-head'],
      [749, 'liveness-reset'],
      [780, 'existing-work'],
    ])
    expect(drafts[3]?.inputs).toMatchObject({ issue: 749 })
  })
})

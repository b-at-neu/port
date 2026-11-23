import { describe, expect, it } from 'vitest'
import { stageNameOfKey, ticketViewOf, viewOfKey } from '@/renderer/lib/ticket-view'
import type { TicketView } from '@/utils/pipeline/stages'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { PipelineItemKind } from '@/types/github'

const queued = (stage: TicketView['stage'], reason: 'new' | 'changes-requested' = 'new'): TicketView => ({ stage, status: { kind: 'queued', reason } })
const running = (stage: TicketView['stage']): TicketView => ({ stage, status: { kind: 'running' } })
const waiting = (stage: TicketView['stage'], gate: 'plan-approval' | 'merge' | 'escalation'): TicketView => ({ stage, status: { kind: 'waiting-on-you', gate } })

const ISSUE_AND_PR: readonly (readonly [LabelKey, TicketView | null, TicketView | null])[] = [
  ['ready', queued('plan'), queued('plan')],
  ['planChangesRequested', queued('plan', 'changes-requested'), queued('plan', 'changes-requested')],
  ['planning', running('plan'), running('plan')],
  ['planReview', waiting('plan', 'plan-approval'), waiting('plan', 'plan-approval')],
  ['planApproved', queued('implement'), queued('implement')],
  ['inProgress', running('implement'), running('implement')],
  ['blocked', { stage: 'implement', status: { kind: 'blocked' } }, { stage: 'review', status: { kind: 'blocked' } }],
  ['readyForReview', queued('review'), queued('review')],
  ['reviewing', running('review'), running('review')],
  ['needsRevision', queued('revise', 'changes-requested'), queued('revise', 'changes-requested')],
  ['revising', running('revise'), running('revise')],
  ['refreshBranch', queued('refresh'), queued('refresh')],
  ['refreshing', running('refresh'), running('refresh')],
  ['approved', waiting('merge', 'merge'), waiting('merge', 'merge')],
  ['needsHuman', waiting('implement', 'escalation'), waiting('review', 'escalation')],
  ['prOpened', null, null],
  ['marker', null, null],
  ['autoPlan', null, null],
]

describe('viewOfKey', () => {
  it.each(ISSUE_AND_PR)('%s maps to its view for an issue and a pull request', (key, issue, pullRequest) => {
    expect(viewOfKey(key, 'issue')).toEqual(issue)
    expect(viewOfKey(key, 'pull-request')).toEqual(pullRequest)
  })
})

describe('ticketViewOf', () => {
  function item(overrides: { readonly key?: LabelKey; readonly mergedAt?: string | null; readonly kind?: PipelineItemKind }) {
    const stages = overrides.key === undefined ? [] : [{ key: overrides.key, name: overrides.key, role: 'gate' as const }]
    return { kind: overrides.kind ?? 'issue', mergedAt: overrides.mergedAt ?? null, stage: overrides.key === undefined ? null : ('gate' as const), stages }
  }

  it('a merged item is merge · done whatever its label says', () => {
    expect(ticketViewOf(item({ key: 'approved', mergedAt: '2026-01-01T00:00:00Z' }))).toEqual({ stage: 'merge', status: { kind: 'done' } })
  })

  it('an item with no stage has no view', () => {
    expect(ticketViewOf(item({}))).toBeNull()
  })

  it('an item reads its winning stage label through the item kind', () => {
    expect(ticketViewOf(item({ key: 'needsHuman', kind: 'pull-request' }))).toEqual(waiting('review', 'escalation'))
  })
})

describe('stageNameOfKey', () => {
  it('names a stage key, and nothing for a key that is no stage', () => {
    expect(stageNameOfKey('refreshBranch')).toBe('Refreshing')
    expect(stageNameOfKey('planChangesRequested')).toBe('Replanning')
    expect(stageNameOfKey('marker')).toBeNull()
  })
})

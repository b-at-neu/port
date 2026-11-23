import { describe, expect, it } from 'vitest'
import type { StageEntry } from '@/types/state'
import type { PipelineItemKind } from '@/types/github'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { phaseDetailsFor } from '@/renderer/board/phase-history'
import { viewOfKey } from '@/renderer/lib/ticket-view'
import type { TicketView } from '@/utils/pipeline/stages'

const NOW = new Date('2026-01-01T12:00:00.000Z')
const MERGED: TicketView = { stage: 'merge', status: { kind: 'done' } }

function entry(key: StageEntry['key'], actor: string | null, minutesAgo: number): StageEntry {
  return { key, actor, at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() }
}

function detailsOf(history: readonly StageEntry[], view: TicketView | null, options: { kind?: PipelineItemKind; viewer?: string | null; cost?: number | null } = {}) {
  return phaseDetailsFor({ history, kind: options.kind ?? 'issue', view, viewer: options.viewer ?? null, now: NOW, currentCostUsd: options.cost ?? null })
}

const viewOf = (key: LabelKey, kind: PipelineItemKind = 'issue') => viewOfKey(key, kind)

describe('phaseDetailsFor', () => {
  it.each([
    ['ready', 'plan'],
    ['planReview', 'plan'],
    ['planApproved', 'implement'],
    ['readyForReview', 'review'],
    ['needsRevision', 'revision'],
    ['revising', 'revision'],
    ['refreshBranch', 'revision'],
    ['refreshing', 'revision'],
    ['approved', 'merge'],
  ] as const)('places a %s entry on the %s phase', (key, phase) => {
    expect(detailsOf([entry(key, 'port-bot', 30)], MERGED)[phase]).toBeDefined()
  })

  it('shows a finished phase as event, actor and relative time', () => {
    const details = detailsOf([entry('ready', 'octo-dev', 180), entry('planning', 'port-bot', 170)], viewOf('planApproved'), { viewer: 'octo-dev' })
    expect(details.plan?.line).toContain('@port-bot')
    expect(details.plan?.line).toContain('2h ago')
  })

  it('resolves the viewer to "you"', () => {
    const details = detailsOf([entry('planApproved', 'octo-dev', 60)], viewOf('readyForReview'), { viewer: 'octo-dev' })
    expect(details.implement?.line).toContain('you')
    expect(details.implement?.line).not.toContain('octo-dev')
  })

  it('the latest entry wins on a re-entry into the same phase', () => {
    const details = detailsOf([entry('needsRevision', 'reviewer-1', 120), entry('revising', 'port-bot', 90), entry('needsRevision', 'reviewer-2', 20)], viewOf('needsRevision', 'pull-request'), { kind: 'pull-request' })
    expect(details.revision?.line).toContain('@reviewer-2')
    expect(details.revision?.line).toContain('20m')
  })

  it('a refresh ticket has revision as its current phase, with duration and cost', () => {
    const details = detailsOf([entry('refreshing', 'port-bot', 12)], viewOf('refreshing', 'pull-request'), { kind: 'pull-request', cost: 0.42 })
    expect(details.revision?.line).toContain('12m')
    expect(details.revision?.line).toContain('$0.42')
    expect(details.merge).toBeUndefined()
  })

  it('the current phase gets duration, and cost only when known', () => {
    const history = [entry('inProgress', 'port-bot', 12)]
    expect(detailsOf(history, viewOf('inProgress'), { cost: 0.42 }).implement?.line).toContain('$0.42')
    expect(detailsOf(history, viewOf('inProgress')).implement?.line).not.toContain('$')
  })

  it('a pending phase has no line', () => {
    expect(detailsOf([entry('ready', 'octo-dev', 10)], viewOf('ready')).review).toBeUndefined()
  })

  it('merged keeps every finished line, even for what was the last stage', () => {
    const details = detailsOf([entry('readyForReview', 'port-bot', 60), entry('approved', 'octo-dev', 5)], MERGED, { kind: 'pull-request' })
    expect(details.review?.line).toContain('@port-bot')
    expect(details.merge?.line).toContain('@octo-dev')
  })

  it('skips an entry with an unparsable timestamp', () => {
    expect(detailsOf([{ key: 'ready', actor: 'octo-dev', at: 'not-a-date' }], viewOf('ready')).plan).toBeUndefined()
  })

  it('no entry for the current phase shows cost alone, or nothing when cost is unknown', () => {
    expect(detailsOf([], viewOf('inProgress'), { cost: 1.5 }).implement?.line).toBe('$1.50')
    expect(detailsOf([], viewOf('inProgress')).implement).toBeUndefined()
  })
})

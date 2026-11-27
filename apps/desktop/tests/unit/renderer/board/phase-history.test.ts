import { describe, expect, it } from 'vitest'
import { phaseDetailsFor } from '@/renderer/board/phase-history'
import type { TicketView } from '@/utils/pipeline/stages'
import type { Event, Stage, StatusKind } from '@/utils/pipeline/ticket'

const NOW = new Date('2026-01-01T12:00:00.000Z')
const MERGED: TicketView = { stage: 'merge', status: { kind: 'done' } }

function viewAt(stage: Stage, status: StatusKind): TicketView {
  return { stage, status: { kind: status } } as TicketView
}

function entry(stage: Stage, status: StatusKind, actor: string | null, minutesAgo: number): Event {
  return { at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), action: 'move', actor, to: { stage, status }, legacy: null }
}

function detailsOf(history: readonly Event[], view: TicketView | null, options: { viewer?: string | null; cost?: number | null } = {}) {
  return phaseDetailsFor({ history, view, viewer: options.viewer ?? null, now: NOW, currentCostUsd: options.cost ?? null })
}

describe('phaseDetailsFor', () => {
  it.each([
    ['plan', 'queued', 'plan'],
    ['plan', 'waiting-on-you', 'plan'],
    ['implement', 'running', 'implement'],
    ['review', 'queued', 'review'],
    ['revise', 'queued', 'revision'],
    ['revise', 'running', 'revision'],
    ['refresh', 'queued', 'revision'],
    ['refresh', 'running', 'revision'],
    ['merge', 'waiting-on-you', 'merge'],
  ] as const)('places a %s %s entry on the %s phase', (stage, status, phase) => {
    expect(detailsOf([entry(stage, status, 'port-bot', 30)], MERGED)[phase]).toBeDefined()
  })

  it('shows a finished phase as event, actor and relative time', () => {
    const details = detailsOf([entry('plan', 'queued', 'octo-dev', 180), entry('plan', 'running', 'port-bot', 170)], viewAt('implement', 'queued'), { viewer: 'octo-dev' })
    expect(details.plan?.line).toContain('@port-bot')
    expect(details.plan?.line).toContain('2h ago')
  })

  it('resolves the viewer to "you"', () => {
    const details = detailsOf([entry('implement', 'queued', 'octo-dev', 60)], viewAt('review', 'queued'), { viewer: 'octo-dev' })
    expect(details.implement?.line).toContain('you')
    expect(details.implement?.line).not.toContain('octo-dev')
  })

  it('the latest entry wins on a re-entry into the same phase', () => {
    const history = [entry('revise', 'queued', 'reviewer-1', 120), entry('revise', 'running', 'port-bot', 90), entry('revise', 'queued', 'reviewer-2', 20)]
    const details = detailsOf(history, viewAt('revise', 'queued'))
    expect(details.revision?.line).toContain('@reviewer-2')
    expect(details.revision?.line).toContain('20m')
  })

  it('a refresh ticket has revision as its current phase, with duration and cost', () => {
    const details = detailsOf([entry('refresh', 'running', 'port-bot', 12)], viewAt('refresh', 'running'), { cost: 0.42 })
    expect(details.revision?.line).toContain('12m')
    expect(details.revision?.line).toContain('$0.42')
    expect(details.merge).toBeUndefined()
  })

  it('the current phase gets duration, and cost only when known', () => {
    const history = [entry('implement', 'running', 'port-bot', 12)]
    const view = viewAt('implement', 'running')
    expect(detailsOf(history, view, { cost: 0.42 }).implement?.line).toContain('$0.42')
    expect(detailsOf(history, view).implement?.line).not.toContain('$')
  })

  it('a pending phase has no line', () => {
    expect(detailsOf([entry('plan', 'queued', 'octo-dev', 10)], viewAt('plan', 'queued')).review).toBeUndefined()
  })

  it('merged keeps every finished line, even for what was the last stage', () => {
    const details = detailsOf([entry('review', 'queued', 'port-bot', 60), entry('merge', 'waiting-on-you', 'octo-dev', 5)], MERGED)
    expect(details.review?.line).toContain('@port-bot')
    expect(details.merge?.line).toContain('@octo-dev')
  })

  it('skips an entry with an unparsable timestamp', () => {
    const bad: Event = { at: 'not-a-date', action: 'move', actor: 'octo-dev', to: { stage: 'plan', status: 'queued' }, legacy: null }
    expect(detailsOf([bad], viewAt('plan', 'queued')).plan).toBeUndefined()
  })

  it('no entry for the current phase shows cost alone, or nothing when cost is unknown', () => {
    const view = viewAt('implement', 'running')
    expect(detailsOf([], view, { cost: 1.5 }).implement?.line).toBe('$1.50')
    expect(detailsOf([], view).implement).toBeUndefined()
  })
})

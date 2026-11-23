import { describe, expect, it } from 'vitest'
import type { StageEntry } from '@/types/state'
import { phaseDetailsFor } from '@/renderer/board/phase-history'

const NOW = new Date('2026-01-01T12:00:00.000Z')

function entry(key: StageEntry['key'], actor: string | null, minutesAgo: number): StageEntry {
  return { key, actor, at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() }
}

describe('phaseDetailsFor', () => {
  it('shows a finished phase as event, actor and relative time', () => {
    const details = phaseDetailsFor({
      history: [entry('ready', 'octo-dev', 180), entry('planning', 'port-bot', 170)],
      kind: 'issue',
      stageKey: 'planApproved',
      merged: false,
      viewer: 'octo-dev',
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.plan?.line).toContain('@port-bot')
    expect(details.plan?.line).toContain('2h ago')
  })

  it('groups the plan-review gate with planning, showing the latest entry of the group', () => {
    const details = phaseDetailsFor({
      history: [entry('planning', 'port-bot', 170), entry('planReview', 'port-bot', 120)],
      kind: 'issue',
      stageKey: 'inProgress',
      merged: false,
      viewer: 'octo-dev',
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.plan?.line).toContain('@port-bot')
    expect(details.plan?.line).toContain('2h ago')
  })

  it('resolves the viewer to "you"', () => {
    const details = phaseDetailsFor({
      history: [entry('planApproved', 'octo-dev', 60)],
      kind: 'issue',
      stageKey: 'readyForReview',
      merged: false,
      viewer: 'octo-dev',
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.implement?.line).toContain('you')
    expect(details.implement?.line).not.toContain('octo-dev')
    expect(details.implement?.line).toContain('1h ago')
  })

  it('omits "by" when the actor is null', () => {
    const details = phaseDetailsFor({
      history: [entry('reviewing', null, 3)],
      kind: 'pull-request',
      stageKey: null,
      merged: true,
      viewer: 'octo-dev',
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.review?.line).toContain('3m ago')
    expect(details.review?.line).not.toContain('@')
  })

  it('the latest entry wins on a re-entry into the same phase', () => {
    const details = phaseDetailsFor({
      history: [entry('needsRevision', 'reviewer-1', 120), entry('revising', 'port-bot', 90), entry('needsRevision', 'reviewer-2', 20)],
      kind: 'pull-request',
      stageKey: 'needsRevision',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.revision?.line).toContain('@reviewer-2')
    expect(details.revision?.line).toContain('20m')
  })

  it('the current phase gets duration and cost', () => {
    const details = phaseDetailsFor({
      history: [entry('inProgress', 'port-bot', 12)],
      kind: 'issue',
      stageKey: 'inProgress',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: 0.42,
    })
    expect(details.implement?.line).toContain('@port-bot')
    expect(details.implement?.line).toContain('12m')
    expect(details.implement?.line).toContain('$0.42')
  })

  it('omits the cost segment when null', () => {
    const details = phaseDetailsFor({
      history: [entry('inProgress', 'port-bot', 12)],
      kind: 'issue',
      stageKey: 'inProgress',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.implement?.line).toContain('12m')
    expect(details.implement?.line).not.toContain('$')
  })

  it('a pending phase has no line', () => {
    const details = phaseDetailsFor({
      history: [entry('ready', 'octo-dev', 10)],
      kind: 'issue',
      stageKey: 'ready',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.review).toBeUndefined()
  })

  it('merged keeps every finished line, even for what was the last stage', () => {
    const details = phaseDetailsFor({
      history: [entry('readyForReview', 'port-bot', 60), entry('approved', 'octo-dev', 5)],
      kind: 'pull-request',
      stageKey: 'approved',
      merged: true,
      viewer: null,
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.review?.line).toContain('@port-bot')
    expect(details.review?.line).toContain('1h ago')
    expect(details.merge?.line).toContain('@octo-dev')
    expect(details.merge?.line).toContain('5m ago')
  })

  it('skips an entry with an unparsable timestamp', () => {
    const details = phaseDetailsFor({
      history: [{ key: 'ready', actor: 'octo-dev', at: 'not-a-date' }],
      kind: 'issue',
      stageKey: 'ready',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.plan).toBeUndefined()
  })

  it('no entry for the current phase shows cost alone when known', () => {
    const details = phaseDetailsFor({
      history: [],
      kind: 'issue',
      stageKey: 'inProgress',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: 1.5,
    })
    expect(details.implement?.line).toBe('$1.50')
  })

  it('no entry and no cost for the current phase is no line at all', () => {
    const details = phaseDetailsFor({
      history: [],
      kind: 'issue',
      stageKey: 'inProgress',
      merged: false,
      viewer: null,
      now: NOW,
      currentCostUsd: null,
    })
    expect(details.implement).toBeUndefined()
  })
})

// Adoption in the planner: a finished stage is adopted instead of reset, dispatched again or escalated.
import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { reconciledItem as item, repositoryState } from '../../../fixtures/board-state'

const NOW = new Date('2026-01-01T01:00:00.000Z')

function plan(items: readonly ReconciledItem[], ledger = createDispatchLedger(), stageLiveness: { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null = { live: [], interrupted: [] }) {
  return planTick({
    repository: repositoryState(items, {}, NOW.toISOString()),
    ledger,
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date('2026-01-01T01:01:00.000Z'),
    now: () => NOW,
    reviewCycleCap: 5,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: {},
    holdSessionRequired: false,
    stageLiveness,
  })
}

describe('planTick — a stage that finished while the app was away', () => {
  const reviewing = (overrides: Partial<ReconciledItem> = {}) =>
    item({
      number: 779,
      kind: 'pull-request',
      stage: 'in-flight',
      stages: [{ key: 'reviewing', name: 'reviewing', role: 'in-flight' }],
      stageHistory: [{ key: 'reviewing', actor: null, at: '2026-01-01T00:30:00.000Z' }],
      headRefOid: '6a95c2c',
      reviews: [{ body: '## Code Review — Cycle 2 · approved\n0 open', submittedAt: '2026-01-01T00:59:00.000Z', commitOid: '6a95c2c' }],
      mergeable: 'MERGEABLE',
      ...overrides,
    })

  it('adopts the approving review and issues no liveness reset, even once the ledger has walked to a confirmed stall', () => {
    const ledger = createDispatchLedger()
    ledger.record('repo-a' as never, 779)
    plan([reviewing()], ledger)
    const report = plan([reviewing()], ledger, { live: [], interrupted: [] })
    const kinds = report.observations.map((o) => o.kind)
    expect(kinds).toContain('adopt')
    expect(kinds).not.toContain('liveness-reset')
    expect(report.observations.find((o) => o.kind === 'adopt')).toMatchObject({ number: 779, agent: 'review', handback: { token: 'approved' } })
  })

  it('still resets a stalled claim that has no evidence of finished work', () => {
    const ledger = createDispatchLedger()
    ledger.record('repo-a' as never, 779)
    const bare = reviewing({ reviews: [] })
    const readAt = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
    const at = (minutes: number) => planTick({ repository: repositoryState([bare], { freshness: { github: { at: readAt(minutes) }, itemStates: { unavailable: 'x' }, sessions: { at: readAt(minutes) }, worktrees: { at: readAt(minutes) }, denials: { at: readAt(minutes) } } }, readAt(minutes)), ledger, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NOW, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: {}, holdSessionRequired: false, stageLiveness: { live: [], interrupted: [] } })
    at(0)
    expect(at(1).observations.map((o) => o.kind)).toEqual(['liveness-reset'])
  })

  it('a settling session is a live one, so its claim is matched and nothing is adopted or reset', () => {
    const report = plan([reviewing()], createDispatchLedger(), { live: ['review #779'], interrupted: [] })
    expect(report.claims).toEqual([{ number: 779, kind: 'pull-request', inFlight: 'reviewing', class: 'matched', retryKey: null }])
    expect(report.observations).toEqual([])
  })
})

describe('planTick — impl on an issue whose pull request is already open', () => {
  const planApproved = (overrides: Partial<ReconciledItem> = {}) => item({ number: 749, stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }], ...overrides })

  it('adopts one open pull request on the issue’s own branch and dispatches no impl', () => {
    const report = plan([planApproved({ closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-the-thing' }] })])
    expect(report.actionable).toEqual([])
    expect(report.observations).toEqual([{ kind: 'adopt', number: 749, itemKind: 'issue', agent: 'impl', trigger: 'planApproved', handback: { token: 'pr-opened', arg: '#780' }, evidence: 'pr' }])
  })

  it('dispatches when there are two open pull requests', () => {
    const report = plan([planApproved({ closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-a' }, { number: 781, state: 'OPEN', headRefName: '749-b' }] })])
    expect(report.actionable).toHaveLength(1)
    expect(report.observations).toEqual([])
  })

  it('dispatches when the closing pull requests were never read', () => {
    const report = plan([planApproved({ closingPullRequests: null })])
    expect(report.actionable).toHaveLength(1)
    expect(report.observations).toEqual([])
  })

  it('dispatches when the only pull request is on a foreign branch', () => {
    const report = plan([planApproved({ closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: 'someone-elses-work' }] })])
    expect(report.actionable).toHaveLength(1)
  })
})

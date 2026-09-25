import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import { createDispatchLedger } from './ledger'
import { planTick } from './plan'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const NEXT_DECISION_AT = new Date('2026-01-01T01:01:00.000Z')
const REPO = 'repo-a' as RepoId

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO,
    repo: 'o/a',
    kind: 'issue',
    number: 1,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/1',
    assignees: ['op'],
    stage: 'trigger',
    stages: [{ key: 'ready', name: 'ready', role: 'trigger' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'waiting',
    statusEvidence: null,
    waitingOn: 'cockpit',
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['ready'],
    sources: ['github'],
    claimedFiles: null,
    ...overrides,
  }
}

function readyRepo(items: readonly ReconciledItem[], overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: REPO,
    repo: 'o/a',
    displayName: 'o/a',
    items,
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z' },
    freshness: {
      github: { at: NOW.toISOString() },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    ...overrides,
  }
}

describe('planTick — blind first', () => {
  it('a not-ready repository is blind, never a dispatch or held count', () => {
    const repo: RepositoryState = { ok: false, repoId: REPO, displayName: 'o/a', reason: 'not-ready', problem: { kind: 'directory-missing' } }
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.blind).toEqual({ reason: 'not-ready' })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([])
    expect(report.claims).toEqual([])
    expect(report.disabledStages).toEqual([])
    expect(report.nextTickAt).toBeNull()
  })

  it('a github-unavailable repository is blind with the message carried through', () => {
    const repo: RepositoryState = {
      ok: false,
      repoId: REPO,
      repo: 'o/a',
      displayName: 'o/a',
      reason: 'github-unavailable',
      kind: 'rate-limited',
      message: 'rate limited',
      freshness: { github: { unavailable: 'rate limited' }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: NOW.toISOString() }, worktrees: { at: NOW.toISOString() }, denials: { at: NOW.toISOString() } },
    }
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.blind).toEqual({ reason: 'github-unavailable', message: 'rate limited' })
  })

  it('an unresolvable viewer is blind, never read as another operator owning everything', () => {
    const repo = readyRepo([], { viewer: null })
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.blind).toEqual({ reason: 'viewer-unknown' })
  })

  it('a GitHub read older than the base interval plus the stale grace is blind, with its age', () => {
    const staleAt = new Date(NOW.getTime() - (60_000 + 30_000 + 1))
    const repo = readyRepo([], { freshness: { github: { at: staleAt.toISOString() }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: NOW.toISOString() }, worktrees: { at: NOW.toISOString() }, denials: { at: NOW.toISOString() } } })
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.blind).toEqual({ reason: 'stale-read', ageMs: 60_000 + 30_000 + 1 })
  })

  it('a read within the grace window is not blind', () => {
    const freshAt = new Date(NOW.getTime() - 60_000)
    const repo = readyRepo([], { freshness: { github: { at: freshAt.toISOString() }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: NOW.toISOString() }, worktrees: { at: NOW.toISOString() }, denials: { at: NOW.toISOString() } } })
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.blind).toBeNull()
    expect(report.nextTickAt).toBe(NEXT_DECISION_AT.toISOString())
  })
})

describe('planTick — trigger-stage items: actionable vs held', () => {
  it('an unassigned trigger item is held, unowned — never actionable', () => {
    const repo = readyRepo([item({ assignees: [] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null }])
    expect(report.actionable).toEqual([])
  })

  it('a trigger item assigned to another operator is held, other-operator', () => {
    const repo = readyRepo([item({ assignees: ['someone-else'] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', trigger: 'ready', reason: 'other-operator', contention: null }])
  })

  it('a session-required trigger item owned by the viewer is held, session-required', () => {
    const repo = readyRepo([item({ sessionRequired: true })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', trigger: 'ready', reason: 'session-required', contention: null }])
  })

  it('an ordinary owned trigger item is actionable with its routed agent', () => {
    const repo = readyRepo([item()])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([{ number: 1, kind: 'issue', trigger: 'ready', agent: 'plan', unchecked: false }])
    expect(report.held).toEqual([])
  })

  it('planApproved routes to impl, needsRevision to revise', () => {
    const repo = readyRepo([
      item({ number: 2, stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }], claimedFiles: ['a.ts'] }),
      item({ number: 3, kind: 'pull-request', stages: [{ key: 'needsRevision', name: 'needs revision', role: 'trigger' }] }),
    ])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([
      { number: 3, kind: 'pull-request', trigger: 'needsRevision', agent: 'revise', unchecked: false },
      { number: 2, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false },
    ])
  })

  it('an item with no trigger/in-flight stage at all is neither actionable nor held', () => {
    const repo = readyRepo([item({ stage: null, stages: [] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([])
    expect(report.claims).toEqual([])
  })
})

describe('planTick — file-contention gate (#106)', () => {
  function inProgressItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 67,
      stage: 'in-flight',
      stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }],
      status: 'in-flight',
      statusEvidence: 'agent-active',
      claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'],
      ...overrides,
    })
  }
  function candidateItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({ number: 52, stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }], claimedFiles: ['src/lib/session.ts'], ...overrides })
  }

  it('a plan with no files fence dispatches unchecked, never held', () => {
    const repo = readyRepo([inProgressItem(), candidateItem({ claimedFiles: null })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: true }])
    expect(report.held).toEqual([])
  })

  it('below the overlap threshold dispatches freely', () => {
    const repo = readyRepo([inProgressItem(), candidateItem()])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false }])
    expect(report.held).toEqual([])
  })

  it('at or above the threshold holds, contended, with the blocker and contended paths named', () => {
    const repo = readyRepo([inProgressItem(), candidateItem({ claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([
      {
        number: 52,
        kind: 'issue',
        trigger: 'planApproved',
        reason: 'contended',
        contention: { blocker: 67, blockerStage: 'in progress', depth: 2, paths: ['src/lib/auth.ts', 'src/lib/session.ts'] },
      },
    ])
  })

  it('a sharedFiles path never contributes to a hold', () => {
    const repo = readyRepo([inProgressItem({ claimedFiles: ['src/lib/registry.ts'] }), candidateItem({ claimedFiles: ['src/lib/registry.ts'] })], {
      concurrency: { sharedFiles: ['src/lib/registry.ts'], overlapThreshold: 1 },
    })
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable).toEqual([{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false }])
    expect(report.held).toEqual([])
  })

  it('an open pr opened issue joins the occupied set the same as an in-flight one', () => {
    const prOpenedItem = item({
      number: 67,
      stage: 'terminal',
      stages: [{ key: 'prOpened', name: 'pr opened', role: 'terminal' }],
      claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'],
    })
    const repo = readyRepo([prOpenedItem, candidateItem({ claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.held).toEqual([
      {
        number: 52,
        kind: 'issue',
        trigger: 'planApproved',
        reason: 'contended',
        contention: { blocker: 67, blockerStage: 'pr opened', depth: 2, paths: ['src/lib/auth.ts', 'src/lib/session.ts'] },
      },
    ])
  })

  it('fewest-conflicts-first: a later survivor is held once an earlier one dispatches', () => {
    const repo = readyRepo([candidateItem({ number: 10, claimedFiles: ['a.ts'] }), candidateItem({ number: 11, claimedFiles: ['a.ts', 'b.ts'] })], {
      concurrency: { sharedFiles: [], overlapThreshold: 1 },
    })
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.actionable.map((a) => a.number)).toEqual([10])
    expect(report.held.map((h) => h.number)).toEqual([11])
  })
})

describe('planTick — in-flight items: claims', () => {
  function inFlightItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({ stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], status: 'stalled', statusEvidence: 'no-claimant', ...overrides })
  }

  it('a session-required in-flight item is never reported as a stall', () => {
    const repo = readyRepo([inFlightItem({ sessionRequired: true })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'session-required', retryKey: null }])
  })

  it('an item this app itself found active is matched', () => {
    const repo = readyRepo([inFlightItem({ status: 'in-flight', statusEvidence: 'agent-active' })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null }])
  })

  it('an unmatched claim with no ledger row is no-record, and never offers a retry', () => {
    const repo = readyRepo([inFlightItem()])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'no-record', retryKey: null }])
  })

  it('walks a dispatched ledger row to suspect, then to a stalled-confirmed retry, across ticks', () => {
    const ledger = createDispatchLedger()
    ledger.record(REPO, 1)
    const repo = readyRepo([inFlightItem()])

    const first = planTick({ repository: repo, ledger, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(first.claims).toEqual([{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'suspect', retryKey: null }])

    const second = planTick({ repository: repo, ledger, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(second.claims).toEqual([{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'stalled-confirmed', retryKey: 'planApproved' }])

    const third = planTick({ repository: repo, ledger, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(third.claims).toEqual([{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'capped', retryKey: null }])
  })
})

describe('planTick — disabledStages', () => {
  it('carries RepositoryState.disabled through unchanged', () => {
    const repo = readyRepo([], { disabled: ['refreshBranch'] })
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW })
    expect(report.disabledStages).toEqual(['refreshBranch'])
  })
})

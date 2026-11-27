import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import { createForceDispatch, createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import type { Run } from '@/utils/pipeline/ticket'
import { reconciledItem as item, repositoryState } from '../../../../support/board-snapshot'
import { queuedAt, runOf, ticketAt } from '../../../../support/tickets'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const NEXT_DECISION_AT = new Date('2026-01-01T01:01:00.000Z')
const REPO = 'repo-a' as RepoId
const NO_CHECK_DISPOSITIONS = {}

function readyRepo(items: readonly ReconciledItem[], overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return repositoryState(items, overrides, NOW.toISOString())
}

describe('planTick — blind first', () => {
  it('a not-ready repository is blind, never a dispatch or held count', () => {
    const repo: RepositoryState = { ok: false, repoId: REPO, displayName: 'o/a', reason: 'not-ready', problem: { kind: 'directory-missing' } }
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.blind).toEqual({ reason: 'not-ready' })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([])
    expect(report.claims).toEqual([])
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
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.blind).toEqual({ reason: 'github-unavailable', message: 'rate limited' })
  })

  it('an unresolvable viewer is blind, never read as another operator owning everything', () => {
    const repo = readyRepo([], { viewer: null })
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.blind).toEqual({ reason: 'viewer-unknown' })
  })

  it('a GitHub read older than the base interval plus the stale grace is blind, with its age', () => {
    const staleAt = new Date(NOW.getTime() - (60_000 + 30_000 + 1))
    const repo = readyRepo([], { freshness: { github: { at: staleAt.toISOString() }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: NOW.toISOString() }, worktrees: { at: NOW.toISOString() }, denials: { at: NOW.toISOString() } } })
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.blind).toEqual({ reason: 'stale-read', ageMs: 60_000 + 30_000 + 1 })
  })

  it('a read within the grace window is not blind', () => {
    const freshAt = new Date(NOW.getTime() - 60_000)
    const repo = readyRepo([], { freshness: { github: { at: freshAt.toISOString() }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: NOW.toISOString() }, worktrees: { at: NOW.toISOString() }, denials: { at: NOW.toISOString() } } })
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.blind).toBeNull()
    expect(report.nextTickAt).toBe(NEXT_DECISION_AT.toISOString())
  })
})

describe('planTick — trigger-stage items: actionable vs held', () => {
  it('an unassigned trigger item is held, unowned — never actionable', () => {
    const repo = readyRepo([item({ assignees: [] })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', stage: 'plan', reason: 'unowned', contention: null, escalation: null }])
    expect(report.actionable).toEqual([])
  })

  it('a trigger item assigned to another operator is held, other-operator', () => {
    const repo = readyRepo([item({ assignees: ['someone-else'] })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', stage: 'plan', reason: 'other-operator', contention: null, escalation: null }])
  })

  it('a session-required trigger item owned by the viewer is held, session-required', () => {
    const repo = readyRepo([item({ sessionRequired: true })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', stage: 'plan', reason: 'session-required', contention: null, escalation: null }])
  })

  it('holdSessionRequired: false dispatches a marked ticket and leaves every other gate intact', () => {
    const repo = readyRepo([item({ sessionRequired: true })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: false })
    expect(report.held).toEqual([])
    expect(report.actionable).toEqual([{ number: 1, kind: 'issue', stage: 'plan', mode: 'fresh', agent: 'plan', unchecked: false, cycle: null }])
  })

  it('holdSessionRequired: false still holds an other-operator item — the session-required rung is the only one it skips', () => {
    const repo = readyRepo([item({ sessionRequired: true, assignees: ['someone-else'] })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: false })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', stage: 'plan', reason: 'other-operator', contention: null, escalation: null }])
  })

  it('an ordinary owned trigger item is actionable with its routed agent', () => {
    const repo = readyRepo([item()])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 1, kind: 'issue', stage: 'plan', mode: 'fresh', agent: 'plan', unchecked: false, cycle: null }])
    expect(report.held).toEqual([])
  })

  it('a queued implement routes to impl, a queued revise to revise', () => {
    const repo = readyRepo([
      item({ number: 2, ticket: ticketAt('implement', queuedAt(), { ticket: 2 }), claimedFiles: ['a.ts'] }),
      item({ number: 3, kind: 'pull-request', ticket: ticketAt('revise', queuedAt('changes-requested'), { ticket: 3, pr: { number: 3, approvedAt: null } }) }),
    ])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([
      { number: 3, kind: 'pull-request', stage: 'revise', mode: 'revise', agent: 'revise', unchecked: false, cycle: null },
      { number: 2, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: false, cycle: null },
    ])
  })

  it('an untracked item is neither actionable nor held', () => {
    const repo = readyRepo([item({ ticket: null })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([])
    expect(report.claims).toEqual([])
  })
})

describe('planTick — file-contention gate (#106)', () => {
  function inProgressItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 67,
      ticket: ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 67 }),
      status: 'in-flight',
      statusEvidence: 'agent-active',
      claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'],
      ...overrides,
    })
  }
  function candidateItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    const number = overrides.number ?? 52
    return item({ number, ticket: ticketAt('implement', queuedAt(), { ticket: number }), claimedFiles: ['src/lib/session.ts'], ...overrides })
  }

  it('a plan with no files fence dispatches unchecked, never held', () => {
    const repo = readyRepo([inProgressItem(), candidateItem({ claimedFiles: null })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 52, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: true, cycle: null }])
    expect(report.held).toEqual([])
  })

  it('below the overlap threshold dispatches freely', () => {
    const repo = readyRepo([inProgressItem(), candidateItem()])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 52, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: false, cycle: null }])
    expect(report.held).toEqual([])
  })

  it('at or above the threshold holds, contended, with the blocker and contended paths named', () => {
    const repo = readyRepo([inProgressItem(), candidateItem({ claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'] })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([
      {
        number: 52,
        kind: 'issue',
        stage: 'implement',
        reason: 'contended',
        contention: { blocker: 67, blockerStage: 'Implementing', depth: 2, paths: ['src/lib/auth.ts', 'src/lib/session.ts'] },
        escalation: null,
      },
    ])
  })

  it('a sharedFiles path never contributes to a hold', () => {
    const repo = readyRepo([inProgressItem({ claimedFiles: ['src/lib/registry.ts'] }), candidateItem({ claimedFiles: ['src/lib/registry.ts'] })], {
      concurrency: { sharedFiles: ['src/lib/registry.ts'], overlapThreshold: 1 },
    })
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 52, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: false, cycle: null }])
    expect(report.held).toEqual([])
  })

  it('an open pr opened issue joins the occupied set the same as an in-flight one', () => {
    const prOpenedItem = item({
      number: 67,
      ticket: ticketAt('review', queuedAt(), { ticket: 67 }),
      claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'],
    })
    const repo = readyRepo([prOpenedItem, candidateItem({ claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'] })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.held).toEqual([
      {
        number: 52,
        kind: 'issue',
        stage: 'implement',
        reason: 'contended',
        contention: { blocker: 67, blockerStage: 'Waiting for review', depth: 2, paths: ['src/lib/auth.ts', 'src/lib/session.ts'] },
        escalation: null,
      },
    ])
  })

  it('fewest-conflicts-first: a later survivor is held once an earlier one dispatches', () => {
    const repo = readyRepo([candidateItem({ number: 10, claimedFiles: ['a.ts'] }), candidateItem({ number: 11, claimedFiles: ['a.ts', 'b.ts'] })], {
      concurrency: { sharedFiles: [], overlapThreshold: 1 },
    })
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable.map((a) => a.number)).toEqual([10])
    expect(report.held.map((h) => h.number)).toEqual([11])
  })
})

describe('planTick — forceDispatch override (#465)', () => {
  function inProgressItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 67,
      ticket: ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 67 }),
      status: 'in-flight',
      statusEvidence: 'agent-active',
      claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'],
      ...overrides,
    })
  }
  function candidateItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    const number = overrides.number ?? 52
    return item({ number, ticket: ticketAt('implement', queuedAt(), { ticket: number }), claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'], ...overrides })
  }

  it('a contended item held without the memo becomes actionable once forced', () => {
    const repo = readyRepo([inProgressItem(), candidateItem()])
    const held = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(held.held.map((h) => h.number)).toEqual([52])

    const forceDispatch = createForceDispatch()
    forceDispatch.set(REPO, 52)
    const forced = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true, forceDispatch })
    expect(forced.actionable).toEqual([{ number: 52, kind: 'issue', stage: 'implement', mode: 'implement', agent: 'impl', unchecked: false, cycle: null }])
    expect(forced.held).toEqual([])
  })

  it('forcing one contended candidate still holds another against the same occupant', () => {
    const repo = readyRepo([inProgressItem(), candidateItem({ number: 52 }), candidateItem({ number: 53, claimedFiles: ['src/lib/auth.ts', 'src/lib/session.ts'] })])
    const forceDispatch = createForceDispatch()
    forceDispatch.set(REPO, 52)
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true, forceDispatch })
    expect(report.actionable.map((a) => a.number)).toEqual([52])
    expect(report.held.map((h) => h.number)).toEqual([53])
  })

  it('a non-contended hold reason is unaffected by the memo', () => {
    const repo = readyRepo([item({ assignees: [] })])
    const forceDispatch = createForceDispatch()
    forceDispatch.set(REPO, 1)
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true, forceDispatch })
    expect(report.held).toEqual([{ number: 1, kind: 'issue', stage: 'plan', reason: 'unowned', contention: null, escalation: null }])
  })

  it('prunes a stale entry once the number is no longer a structured candidate', () => {
    const repo = readyRepo([candidateItem({ claimedFiles: null })])
    const forceDispatch = createForceDispatch()
    forceDispatch.set(REPO, 52)
    planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true, forceDispatch })
    expect(forceDispatch.has(REPO, 52)).toBe(false)
  })
})

describe('planTick — in-flight items: claims', () => {
  function inFlightItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({ ticket: ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 1 }), status: 'stalled', statusEvidence: 'no-claimant', ...overrides })
  }

  it('a session-required in-flight item is never reported as a stall', () => {
    const repo = readyRepo([inFlightItem({ sessionRequired: true })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'session-required', retryable: false }])
  })

  it('holdSessionRequired: false matches a session-required in-flight item through startedTasks like any other', () => {
    const repo = readyRepo([inFlightItem({ sessionRequired: true })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: ['impl #1'], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: false })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'matched', retryable: false }])
  })

  it('an item this app itself found active is matched', () => {
    const repo = readyRepo([inFlightItem({ status: 'in-flight', statusEvidence: 'agent-active' })])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'matched', retryable: false }])
  })

  it('an unmatched claim with no run is no-record, and never offers a retry', () => {
    const repo = readyRepo([inFlightItem()])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'no-record', retryable: false }])
  })

  const claimsWith = (runs: readonly Run[], readAt: string) => {
    const repository = readyRepo([inFlightItem()], { freshness: { github: { at: readAt }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: readAt }, worktrees: { at: readAt }, denials: { at: readAt } } })
    return planTick({ repository, runsOf: () => runs, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true }).claims
  }
  const ENDED = runOf({ item: { kind: 'issue', number: 1 }, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:10:00.000Z' })

  it('a claim whose run ended with no hand-back is a stalled-confirmed retry once a read postdates the end', () => {
    expect(claimsWith([ENDED], NOW.toISOString())).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'stalled-confirmed', retryable: true }])
  })

  it('a claim whose run handed back is capped, never reset', () => {
    expect(claimsWith([{ ...ENDED, handback: { token: 'pr-opened', arg: '#8' } }], NOW.toISOString())).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'capped', retryable: false }])
  })

  function tickWith(repo: Extract<RepositoryState, { ok: true }>, stageLiveness: { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null) {
    return planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true, stageLiveness })
  }

  it('stageLiveness: null is byte-identical to today — a transcript in-flight status still matches', () => {
    const repo = readyRepo([inFlightItem({ status: 'in-flight', statusEvidence: 'agent-active' })])
    expect(tickWith(repo, null).claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'matched', retryable: false }])
  })

  it('stageLiveness: a live description matches, ignoring item.status entirely', () => {
    const repo = readyRepo([inFlightItem()])
    expect(tickWith(repo, { live: ['impl #1'], interrupted: [] }).claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'matched', retryable: false }])
  })

  it('stageLiveness: an interrupted description reports class interrupted, with no retryKey', () => {
    const repo = readyRepo([inFlightItem()])
    expect(tickWith(repo, { live: [], interrupted: ['impl #1'] }).claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'interrupted', retryable: false }])
  })

  it('stageLiveness non-null: a transcript in-flight status alone is no longer matched', () => {
    const repo = readyRepo([inFlightItem({ status: 'in-flight', statusEvidence: 'agent-active' })])
    expect(tickWith(repo, { live: [], interrupted: [] }).claims).toEqual([{ number: 1, kind: 'issue', stage: 'implement', class: 'no-record', retryable: false }])
  })
})

describe('planTick — autoApprovals', () => {
  it('reports an autoPlan issue waiting on plan approval, assigned to the viewer', () => {
    const autoPlanItem = item({ number: 7, ticket: ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }, { ticket: 7, autoPlan: true }) })
    const repo = readyRepo([autoPlanItem])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.autoApprovals).toEqual([{ number: 7 }])
  })
})

describe('planTick — endedStages / labelRepairs (#330)', () => {
  it('an error outcome yields no liveness-reset of its own — the app rolled the label back itself', () => {
    const repo = readyRepo([item({ ticket: ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 1 }), status: 'stalled', statusEvidence: 'no-claimant' })])
    const report = planTick({
      repository: repo,
      unknownStreaks: createUnknownStreaks(),
      nextDecisionAt: NEXT_DECISION_AT,
      now: () => NOW,
      reviewCycleCap: 5,
      startedTasks: [],
      refreshMemo: createRefreshMemo(),
      checkDispositions: NO_CHECK_DISPOSITIONS,
      holdSessionRequired: true,
      endedStages: [{ agent: 'impl', number: 1, outcome: 'error', at: '2025-12-31T00:00:00.000Z', labels: { kind: 'applied' } }],
    })
    expect(report.observations.filter((o) => o.kind === 'liveness-reset')).toEqual([])
  })

  it('labelRepairs is [] on a blind report', () => {
    const repo: RepositoryState = { ok: false, repoId: REPO, displayName: 'o/a', reason: 'not-ready', problem: { kind: 'directory-missing' } }
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.labelRepairs).toEqual([])
  })

  it('every existing case still passes with endedStages: [] (the default)', () => {
    const repo = readyRepo([item()])
    const report = planTick({ repository: repo, unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true, endedStages: [] })
    expect(report.labelRepairs).toEqual([])
  })
})

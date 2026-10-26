import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { TickReport } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { autoApprovalsOf, autoPlanApprovingOf, autoPlanStatusOf, autoPlanSwapCandidatesOf } from '@/main/tick/auto-plan'
import { reconciledItem } from '../../../fixtures/board-state'

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({
    stage: 'trigger',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    autoPlan: true,
    matchedKeys: ['planReview'],
    ...overrides,
  })
}

describe('autoApprovalsOf', () => {
  it('advances an autoPlan issue at planReview alone, assigned to the viewer', () => {
    expect(autoApprovalsOf([item()], 'op')).toEqual([{ number: 1 }])
  })

  it('leaves an issue without autoPlan untouched', () => {
    expect(autoApprovalsOf([item({ autoPlan: false })], 'op')).toEqual([])
  })

  it('leaves a contradictory item (more than one stage label) untouched', () => {
    const contradictory = item({
      stages: [
        { key: 'planReview', name: 'plan review', role: 'gate' },
        { key: 'planApproved', name: 'plan approved', role: 'trigger' },
      ],
    })
    expect(autoApprovalsOf([contradictory], 'op')).toEqual([])
  })

  it('leaves a pull request untouched, even with autoPlan set', () => {
    expect(autoApprovalsOf([item({ kind: 'pull-request' })], 'op')).toEqual([])
  })

  it('leaves an item assigned to someone else untouched', () => {
    expect(autoApprovalsOf([item({ assignees: ['someone-else'] })], 'op')).toEqual([])
  })

  it('leaves an unassigned item untouched', () => {
    expect(autoApprovalsOf([item({ assignees: [] })], 'op')).toEqual([])
  })

  it('still qualifies a session-required item — the cockpit rule is ignored here', () => {
    expect(autoApprovalsOf([item({ sessionRequired: true })], 'op')).toEqual([{ number: 1 }])
  })

  it('returns [] for a null viewer', () => {
    expect(autoApprovalsOf([item()], null)).toEqual([])
  })
})

const REPO = 'repo-a' as RepoId

function report(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [{ number: 7 }, { number: 8 }], labelRepairs: [], ...overrides }
}

function dispatchRow(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

const NONE: ReadonlySet<number> = new Set()

describe('autoPlanSwapCandidatesOf', () => {
  it('lists every candidate for an app owner that is dispatching', () => {
    expect(autoPlanSwapCandidatesOf({ report: report(), owner: 'app', runState: 'dispatching' })).toEqual([7, 8])
  })

  it.each(['paused', 'draining'] as const)('lists none for an app owner that is %s', (runState) => {
    expect(autoPlanSwapCandidatesOf({ report: report(), owner: 'app', runState })).toEqual([])
  })

  it.each(['paused', 'draining'] as const)('lists every candidate for a terminal owner whatever the app run state (%s)', (runState) => {
    expect(autoPlanSwapCandidatesOf({ report: report(), owner: 'terminal', runState })).toEqual([7, 8])
  })

  it.each(['none', 'unreadable'] as const)('lists none when the owner is %s', (owner) => {
    expect(autoPlanSwapCandidatesOf({ report: report(), owner, runState: 'dispatching' })).toEqual([])
  })

  it.each(['app', 'terminal'] as const)('lists none on a blind report for a %s owner', (owner) => {
    expect(autoPlanSwapCandidatesOf({ report: report({ blind: { reason: 'github-unavailable' } as never }), owner, runState: 'dispatching' })).toEqual([])
  })
})

describe('autoPlanApprovingOf', () => {
  it('drops the numbers whose swap was refused', () => {
    expect(autoPlanApprovingOf({ report: report(), owner: 'app', runState: 'dispatching', refused: new Set([8]) })).toEqual([7])
  })
})

describe('autoPlanStatusOf', () => {
  it('returns one entry per report, built from its own dispatch row', () => {
    expect(autoPlanStatusOf([report()], [dispatchRow()], () => NONE)).toEqual([{ repoId: REPO, approving: [7, 8] }])
  })

  it('returns an empty list when the report has no dispatch row', () => {
    expect(autoPlanStatusOf([report()], [], () => NONE)).toEqual([{ repoId: REPO, approving: [] }])
  })

  it('reads the refused set for the report’s own repository', () => {
    expect(autoPlanStatusOf([report()], [dispatchRow()], (repoId) => (repoId === REPO ? new Set([7]) : NONE))).toEqual([{ repoId: REPO, approving: [8] }])
  })

  it('stands down for a paused repository', () => {
    expect(autoPlanStatusOf([report()], [dispatchRow({ runState: 'paused' })], () => NONE)).toEqual([{ repoId: REPO, approving: [] }])
  })
})

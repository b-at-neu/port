import { describe, expect, it } from 'vitest'
import { labelName, resolveVocabulary } from '../labels/vocabulary'
import type { RepoId } from '../repos'
import type { ReconciledItem, StageLabel } from '../state/types'
import type { LabelAuditEntry } from '../writes/types'
import { RETRY_TRIGGER, actionsFor, pausedTriggerFrom } from './plan'

const VOCABULARY = resolveVocabulary({})

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: 'issue',
    number: 148,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/148',
    assignees: [],
    stage: null,
    stages: [],
    stageAmbiguous: false,
    marked: false,
    autoPlan: false,
    status: 'unstaged',
    statusEvidence: null,
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: [],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    ...overrides,
  }
}

function stageLabel(key: StageLabel['key'], role: StageLabel['role']): StageLabel {
  return { key, name: key, role }
}

describe('actionsFor — pause', () => {
  it('offers pause on a trigger-labelled item, with the absent-key guard for a mapped in-flight label', () => {
    const it1 = item({ stage: 'trigger', stages: [stageLabel('planApproved', 'trigger')], assignees: ['op'] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    expect(result.pause).toEqual({
      available: true,
      plan: { add: [], remove: ['planApproved'], addAssignees: [], removeAssignees: [], expect: { present: ['planApproved'], absent: ['inProgress'], assignees: { kind: 'exactly', logins: ['op'] } }, action: 'pause' },
    })
  })

  it('has no absent-key guard for planChangesRequested — no in-flight label maps back to it', () => {
    const it1 = item({ stage: 'trigger', stages: [stageLabel('planChangesRequested', 'trigger')] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    expect(result.pause).toEqual({
      available: true,
      plan: { add: [], remove: ['planChangesRequested'], addAssignees: ['op'], removeAssignees: [], expect: { present: ['planChangesRequested'], absent: [], assignees: { kind: 'unassigned' } }, action: 'pause' },
    })
  })

  it('is not-applicable off a trigger role', () => {
    const it1 = item({ stage: 'in-flight', stages: [stageLabel('inProgress', 'in-flight')] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).pause).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('actionsFor — resume', () => {
  it('offers resume when marked with no role-bearing label at all, expect.absent every non-marker key', () => {
    const it1 = item({ marked: true, stage: null, stages: [] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    expect(result.resume.available).toBe(true)
    if (!result.resume.available) return
    expect(result.resume.plan.add).toEqual([])
    expect(result.resume.plan.expect.present).toEqual([])
    expect(result.resume.plan.expect.absent).toContain('ready')
    expect(result.resume.plan.expect.absent).toContain('approved')
    expect(result.resume.plan.expect.absent).not.toContain('marker')
  })

  it('is not-applicable when unmarked, even with no stage', () => {
    const it1 = item({ marked: false, stage: null, stages: [] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).resume).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('is not-applicable when a stage is still present', () => {
    const it1 = item({ marked: true, stage: 'trigger', stages: [stageLabel('ready', 'trigger')] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).resume).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('actionsFor — retry', () => {
  it('offers retry on every in-flight-labelled row, not only a displayed stall', () => {
    const it1 = item({ status: 'in-flight', stage: 'in-flight', stages: [stageLabel('inProgress', 'in-flight')], assignees: ['op'] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    expect(result.retry).toEqual({
      available: true,
      plan: {
        add: ['planApproved'],
        remove: ['inProgress'],
        addAssignees: [],
        removeAssignees: [],
        expect: { present: ['inProgress'], absent: ['planApproved'], assignees: { kind: 'exactly', logins: ['op'] } },
        action: 'retry',
      },
    })
  })

  it('offers retry on a suppressed stall the same as a displayed one — role-based, not status-based', () => {
    const it1 = item({ status: 'stalled', stage: 'in-flight', stages: [stageLabel('revising', 'in-flight')] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).retry.available).toBe(true)
  })

  it('is not-applicable off an in-flight role', () => {
    const it1 = item({ stage: 'gate', stages: [stageLabel('blocked', 'gate')] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).retry).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('actionsFor — stop', () => {
  it('offers stop on every in-flight-labelled row, adding nothing — the deliberate difference from retry', () => {
    const it1 = item({ stage: 'in-flight', stages: [stageLabel('reviewing', 'in-flight')], assignees: ['op'] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    expect(result.stop).toEqual({
      available: true,
      plan: { add: [], remove: ['reviewing'], addAssignees: [], removeAssignees: [], expect: { present: ['reviewing'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } }, action: 'stop' },
    })
  })

  it('is not-applicable off an in-flight role', () => {
    const it1 = item({ stage: 'trigger', stages: [stageLabel('ready', 'trigger')] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).stop).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('refuses not-owned when assigned to someone else, the same as pause/resume/retry', () => {
    const it1 = item({ stage: 'in-flight', stages: [stageLabel('inProgress', 'in-flight')], assignees: ['other'] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).stop).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('actionsFor — gate', () => {
  function pr(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({ kind: 'pull-request', stage: 'in-flight', stages: [stageLabel('reviewing', 'in-flight')], marked: false, ...overrides })
  }

  it('is offered on an ungated pull request regardless of assignee', () => {
    const result = actionsFor({ item: pr({ assignees: ['someone-else'] }), viewer: 'op', approvalGate: true })
    expect(result.gate).toEqual({
      available: true,
      plan: { add: ['marker'], remove: [], addAssignees: [], removeAssignees: [], expect: { present: [], absent: ['marker'], assignees: { kind: 'any' } }, action: 'gate' },
    })
  })

  it('is absent (not-applicable) when approvalGate is false', () => {
    expect(actionsFor({ item: pr(), viewer: 'op', approvalGate: false }).gate).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('is not-applicable on an issue', () => {
    expect(actionsFor({ item: item({ stage: 'in-flight', stages: [stageLabel('inProgress', 'in-flight')] }), viewer: 'op', approvalGate: true }).gate).toEqual({
      available: false,
      reason: 'not-applicable',
    })
  })

  it('is not-applicable once already marked', () => {
    expect(actionsFor({ item: pr({ marked: true }), viewer: 'op', approvalGate: true }).gate).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('is available even when viewer is unknown — gate runs no ownership check', () => {
    expect(actionsFor({ item: pr(), viewer: null, approvalGate: true }).gate.available).toBe(true)
  })
})

describe('actionsFor — refresh', () => {
  function pr(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({ kind: 'pull-request', assignees: ['op'], ...overrides })
  }

  it('offers refresh on a trigger-labelled pull request', () => {
    const it1 = pr({ stage: 'trigger', stages: [stageLabel('readyForReview', 'trigger')] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    expect(result.refresh).toEqual({
      available: true,
      plan: {
        add: ['refreshBranch'],
        remove: [],
        addAssignees: [],
        removeAssignees: [],
        expect: { present: ['readyForReview'], absent: ['refreshBranch', 'refreshing'], assignees: { kind: 'exactly', logins: ['op'] } },
        action: 'refresh',
      },
    })
  })

  it('offers refresh on a terminal-labelled pull request', () => {
    const it1 = pr({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).refresh.available).toBe(true)
  })

  it('is not-applicable on an issue', () => {
    const it1 = item({ stage: 'trigger', stages: [stageLabel('ready', 'trigger')], assignees: ['op'] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).refresh).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('is not-applicable while in-flight, gated, carrying refreshBranch, or carrying refreshing', () => {
    const inFlight = pr({ stage: 'in-flight', stages: [stageLabel('reviewing', 'in-flight')] })
    expect(actionsFor({ item: inFlight, viewer: 'op', approvalGate: true }).refresh).toEqual({ available: false, reason: 'not-applicable' })

    const gated = pr({ stage: 'gate', stages: [stageLabel('needsHuman', 'gate')] })
    expect(actionsFor({ item: gated, viewer: 'op', approvalGate: true }).refresh).toEqual({ available: false, reason: 'not-applicable' })

    const refreshing = pr({ stage: 'terminal', stages: [stageLabel('approved', 'terminal'), stageLabel('refreshing', 'in-flight')] })
    expect(actionsFor({ item: refreshing, viewer: 'op', approvalGate: true }).refresh).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('refuses not-owned the same as pause/resume/retry/stop', () => {
    const it1 = pr({ stage: 'trigger', stages: [stageLabel('readyForReview', 'trigger')], assignees: ['other'] })
    expect(actionsFor({ item: it1, viewer: 'op', approvalGate: true }).refresh).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('actionsFor — ownership', () => {
  const triggerItem = item({ stage: 'trigger', stages: [stageLabel('ready', 'trigger')] })

  it('refuses pause/resume/retry/stop viewer-unknown when viewer is null', () => {
    const result = actionsFor({ item: triggerItem, viewer: null, approvalGate: true })
    expect(result.pause).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.resume).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.retry).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.stop).toEqual({ available: false, reason: 'viewer-unknown' })
  })

  it('allows an unassigned item', () => {
    expect(actionsFor({ item: item({ ...triggerItem, assignees: [] }), viewer: 'op', approvalGate: true }).pause.available).toBe(true)
  })

  it('allows an item assigned exactly to the viewer', () => {
    expect(actionsFor({ item: item({ ...triggerItem, assignees: ['op'] }), viewer: 'op', approvalGate: true }).pause.available).toBe(true)
  })

  it('refuses not-owned when assigned to someone else', () => {
    expect(actionsFor({ item: item({ ...triggerItem, assignees: ['other'] }), viewer: 'op', approvalGate: true }).pause).toEqual({ available: false, reason: 'not-owned' })
  })

  it('refuses not-owned when assigned to the viewer among several — viewer-among-several is refused, not accepted', () => {
    expect(actionsFor({ item: item({ ...triggerItem, assignees: ['op', 'other'] }), viewer: 'op', approvalGate: true }).pause).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('RETRY_TRIGGER', () => {
  it('covers exactly the five in-flight labels', () => {
    expect(Object.keys(RETRY_TRIGGER).sort()).toEqual(['inProgress', 'planning', 'refreshing', 'reviewing', 'revising'])
  })
})

describe('pausedTriggerFrom', () => {
  function auditEntry(present: readonly string[]): LabelAuditEntry {
    return {
      at: '2026-01-01T00:00:00Z',
      repo: 'o/r',
      repoId: 'repo-a' as RepoId,
      kind: 'issue',
      number: 148,
      action: 'pause',
      ownership: 'app',
      precondition: { present, absent: [], assignees: { kind: 'any' } },
      observed: null,
      call: null,
      commentBytes: null,
      result: { kind: 'applied', argv: [] },
    }
  }

  it('round-trips a pause plan through its own audit entry', () => {
    const it1 = item({ stage: 'trigger', stages: [stageLabel('planApproved', 'trigger')] })
    const result = actionsFor({ item: it1, viewer: 'op', approvalGate: true })
    if (!result.pause.available) throw new Error('expected pause to be available')
    // A real audit entry carries resolved names, never bare LabelKeys, so the round trip must go through that same resolution.
    const names = result.pause.plan.expect.present.map((key) => labelName(VOCABULARY, key) ?? key)
    const entry = auditEntry(names)
    expect(pausedTriggerFrom(entry, VOCABULARY)).toBe('planApproved')
  })

  it('returns null for a precondition with no present names, or more than one', () => {
    expect(pausedTriggerFrom(auditEntry([]), VOCABULARY)).toBeNull()
    expect(pausedTriggerFrom(auditEntry(['ready', 'plan approved']), VOCABULARY)).toBeNull()
  })

  it('returns null for a name that no longer resolves to a key', () => {
    expect(pausedTriggerFrom(auditEntry(['a since-renamed label']), VOCABULARY)).toBeNull()
  })
})

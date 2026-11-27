import { describe, expect, it } from 'vitest'
import { DISPATCH_PROMPT, freeSlots, liveCount, promptFor, REFRESH_PROMPT, survived } from '@/main/dispatch/launch'
import type { ResolvedItem } from '@/types/github'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { TickActionable } from '@/types/tick'
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import type { RepoId } from '@/utils/repos'
import { queuedAt } from '../../../support/tickets'

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    repoId: 'repo-a' as RepoId,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending' },
    title: null,
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
    usage: null,
    backgroundTasks: [],
    stage: null,
    lastResult: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

describe('liveCount / freeSlots', () => {
  it('counts only non-ended snapshots', () => {
    expect(liveCount([snapshot({ phase: 'ready' }), snapshot({ phase: 'ended' }), snapshot({ phase: 'streaming' })])).toBe(2)
  })

  it('never returns a negative free count', () => {
    expect(freeSlots(1, [snapshot(), snapshot({ sessionKey: 'hosted-2' as SessionKey })])).toBe(0)
  })

  it('reports the remainder under the limit', () => {
    expect(freeSlots(4, [snapshot()])).toBe(3)
  })
})

const CANDIDATE = { number: 52, kind: 'issue', stage: 'implement', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null } as TickActionable

function resolved(labels: readonly string[], assignees: readonly string[] = ['op']): ResolvedItem {
  return { number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels, assignees, headRefName: null, author: null }
}

describe('survived — the ticket', () => {
  const queued = { stage: 'implement', status: queuedAt() } as const

  it('does not survive an item with no ticket, even when GitHub shows the trigger label', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, 'op', null)).toBe(false)
  })

  it('survives on the ticket even when every label was removed on GitHub', () => {
    expect(survived(resolved([]), CANDIDATE, 'op', queued)).toBe(true)
  })

  it('does not survive a ticket that moved to another stage', () => {
    expect(survived(resolved([]), CANDIDATE, 'op', { stage: 'review', status: queuedAt() })).toBe(false)
  })

  it('does not survive a ticket that is no longer queued', () => {
    expect(survived(resolved([]), CANDIDATE, 'op', { stage: 'implement', status: { kind: 'running', runId: 'run-1' } })).toBe(false)
  })

  it('still takes the assignees from GitHub', () => {
    expect(survived(resolved([], ['someone-else']), CANDIDATE, 'op', queued)).toBe(false)
  })
})

function actionableOf(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', stage: 'implement', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

describe('promptFor', () => {
  const INSTRUCTION = 'Run your pipeline stage for #52. port has already moved its label. Follow your Pre-flight, Work, and Handoff steps exactly.'

  it.each([
    [{ trigger: 'ready', agent: 'plan' }, `Plan stage for issue #52. ${INSTRUCTION}`],
    [{}, `Implementation stage for issue #52. ${INSTRUCTION}`],
    [{ kind: 'pull-request', trigger: 'readyForReview', agent: 'review' }, `Review stage for pull request #52. ${INSTRUCTION}`],
    [{ kind: 'pull-request', trigger: 'needsRevision', agent: 'revise' }, `Revision stage for pull request #52. ${INSTRUCTION}`],
  ] as const)('names the stage and the item for %j', (overrides, expected) => {
    expect(promptFor(actionableOf(overrides))).toBe(expected)
  })

  it('fills every placeholder, with the number twice', () => {
    const prompt = promptFor(actionableOf())
    expect(prompt).not.toMatch(/<[A-Za-z]+>/)
    expect(prompt.split('#52')).toHaveLength(3)
    expect(DISPATCH_PROMPT.split('<n>')).toHaveLength(3)
  })

  it('names the refresh stage for a refreshBranch trigger, with the number twice', () => {
    const prompt = promptFor(actionableOf({ kind: 'pull-request', trigger: 'refreshBranch', agent: 'revise' }))
    expect(prompt).toBe('Refresh stage for pull request #52. Run your pipeline stage for pull request #52 in refresh mode.')
    expect(REFRESH_PROMPT.split('<n>')).toHaveLength(3)
  })
})

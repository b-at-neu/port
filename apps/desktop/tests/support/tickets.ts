import type { Run, Ticket } from '@/utils/pipeline/ticket'

export const NOW = '2026-11-23T12:00:00.000Z'

export const REPO = 'owner/repo' as Ticket['repo']

export function runOf(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    stage: 'implement',
    item: { kind: 'issue', number: 843 },
    agent: 'impl',
    trigger: 'planApproved',
    model: 'sonnet',
    title: null,
    sessionKey: 'session-1' as Run['sessionKey'],
    claudeSessionId: null,
    worktree: { path: '/wt/run-1', branch: 'branch-1', baseSha: 'abc' },
    startedAt: NOW,
    endedAt: null,
    outcome: null,
    handback: null,
    costUsd: null,
    operatorJoinedAt: null,
    failure: null,
    interruption: null,
    networkRetries: 0,
    denials: [],
    ...overrides,
  }
}

/** A ticket at one stage and status; the `pr` defaults to open for a stage that acts on a pull request. */
export function ticketAt(stage: Ticket['stage'], status: Ticket['status'], overrides: Partial<Ticket> = {}): Ticket {
  const onPr = stage === 'review' || stage === 'revise' || stage === 'refresh' || stage === 'merge'
  return ticketOf({ stage, status, pr: onPr ? { number: 900, approvedAt: null } : null, ...overrides })
}

export const queuedAt = (reason: 'new' | 'changes-requested' | 'retry' = 'new'): Ticket['status'] => ({ kind: 'queued', reason, since: NOW })

export function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    rev: 0,
    repo: REPO,
    ticket: 843,
    pr: null,
    stage: 'plan',
    status: { kind: 'queued', reason: 'new', since: NOW },
    autoPlan: false,
    reviewCycles: 0,
    runs: [],
    history: [],
    mirror: { written: [], failure: null },
    ...overrides,
  }
}

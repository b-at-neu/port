import { describe, expect, it } from 'vitest'
import { applyRunChange, denialsOf, dispatchRecordOf, interruptedOf, isOpen, outcomeOf, recoverRuns, unmatchedClaimOf } from '@/main/pipeline/runs'
import { applyEvent } from '@/main/pipeline/transitions'
import type { RunChange } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import { RUN_CAP, type Run, type Ticket } from '@/utils/pipeline/ticket'
import { NOW, REPO, runOf, ticketOf } from '../../../../support/tickets'

const LATER = '2026-11-23T13:00:00.000Z'
const OUTCOME: StageOutcome = { kind: 'completed', detail: null, costUsd: 0.5, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: { token: 'pr-opened', arg: '#8' } }
const running = (runId: string | null = null, runs: Run[] = []) => ticketOf({ ticket: 843, stage: 'implement', status: { kind: 'running', runId }, runs })

function change(ticket: Ticket, runId: string, next: RunChange, at = LATER) {
  const result = applyRunChange(ticket, { kind: 'run', runId, change: next }, at)
  if (!result.ok) throw new Error(result.reason)
  return result
}

describe('applyRunChange — the table', () => {
  const open = runOf()
  const held = running('run-1', [open])
  const onlyRun = (ticket: Ticket) => ticket.runs[0] as Run

  it.each<[string, RunChange, Partial<Run>]>([
    ['session sets the Claude session id once', { kind: 'session', claudeSessionId: 'sdk-1' }, { claudeSessionId: 'sdk-1' }],
    ['joined sets the instant once', { kind: 'joined', at: LATER }, { operatorJoinedAt: LATER }],
    ['handback records the outcome and stays open', { kind: 'handback', outcome: { ...OUTCOME, kind: 'questions', handback: null } }, { outcome: 'questions', endedAt: null }],
    ['ended with an outcome closes the run', { kind: 'ended', outcome: OUTCOME }, { outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, costUsd: 0.5, endedAt: LATER }],
    ['ended with none only closes it', { kind: 'ended', outcome: null }, { outcome: null, endedAt: LATER }],
    ['quit interrupts an open run', { kind: 'quit' }, { interruption: { reason: 'quit', detail: null, at: LATER, resetsAt: null }, endedAt: LATER }],
    ['denied appends', { kind: 'denied', denial: { id: 'd1', toolName: 'Bash', inputSummary: 'x', rule: 'r', at: LATER } }, { denials: [{ id: 'd1', toolName: 'Bash', inputSummary: 'x', rule: 'r', at: LATER }] }],
  ])('%s', (_name, next, expected) => {
    expect(onlyRun(change(held, 'run-1', next).ticket)).toMatchObject(expected)
  })

  it('reports no change for a session id or join that is already set', () => {
    const set = running('run-1', [runOf({ claudeSessionId: 'sdk-0', operatorJoinedAt: NOW })])
    expect(change(set, 'run-1', { kind: 'session', claudeSessionId: 'sdk-1' }).changed).toBe(false)
    expect(change(set, 'run-1', { kind: 'joined', at: LATER }).changed).toBe(false)
  })

  it('interrupted records the reason and detail, and a network one sets its own backoff and keeps the retry count', () => {
    const base = { kind: 'interrupted', detail: 'boom', resetsAt: '2026-11-24T00:00:00.000Z', costUsd: null, outcome: null } as const
    const usage = onlyRun(change(held, 'run-1', { ...base, reason: 'usage-limit' }).ticket)
    expect(usage.interruption).toEqual({ reason: 'usage-limit', detail: 'boom', at: LATER, resetsAt: '2026-11-24T00:00:00.000Z' })

    const retried = running('run-1', [runOf({ networkRetries: 1 })])
    const network = onlyRun(change(retried, 'run-1', { ...base, reason: 'network' }).ticket)
    expect(network).toMatchObject({ networkRetries: 1, interruption: { reason: 'network', resetsAt: new Date(Date.parse(LATER) + 300_000).toISOString() } })
    expect(onlyRun(change(retried, 'run-1', { ...base, reason: 'error' }).ticket).networkRetries).toBe(0)
  })

  it('resumed clears the interruption, counts a network retry and takes the new session', () => {
    const interrupted = running('run-1', [runOf({ endedAt: NOW, networkRetries: 1, outcome: 'interrupted', interruption: { reason: 'network', detail: null, at: NOW, resetsAt: null } })])
    expect(onlyRun(change(interrupted, 'run-1', { kind: 'resumed', sessionKey: 'session-2' as never }).ticket)).toMatchObject({ sessionKey: 'session-2', endedAt: null, interruption: null, outcome: null, networkRetries: 2 })
    const other = running('run-1', [runOf({ endedAt: NOW, interruption: { reason: 'error', detail: null, at: NOW, resetsAt: null } })])
    expect(onlyRun(change(other, 'run-1', { kind: 'resumed', sessionKey: 'session-2' as never }).ticket).networkRetries).toBe(0)
  })

  it('cleared leaves the run as closed history, never open again', () => {
    const interrupted = runOf({ endedAt: NOW, interruption: { reason: 'crash', detail: null, at: NOW, resetsAt: null } })
    const cleared = onlyRun(change(running('run-1', [interrupted]), 'run-1', { kind: 'cleared' }).ticket)
    expect(cleared).toMatchObject({ interruption: null, outcome: 'interrupted' })
    expect(isOpen(cleared)).toBe(false)
  })

  it('denied replaces a denial of the same rule, and is capped at twenty', () => {
    const denial = (id: string, rule: string) => ({ kind: 'denied', denial: { id, toolName: 'Bash', inputSummary: '', rule, at: LATER } }) as const
    let ticket = change(held, 'run-1', denial('a', 'same')).ticket
    ticket = change(ticket, 'run-1', denial('b', 'same')).ticket
    expect(onlyRun(ticket).denials.map((d) => d.id)).toEqual(['b'])
    for (let i = 0; i < 25; i++) ticket = change(ticket, 'run-1', denial(`n${String(i)}`, `rule-${String(i)}`)).ticket
    expect(onlyRun(ticket).denials).toHaveLength(20)
  })

  it('denial-dismissed removes one denial and denials-cleared every one of a rule', () => {
    const withDenials = running('run-1', [runOf({ denials: [{ id: 'a', toolName: 'Bash', inputSummary: '', rule: 'r1', at: NOW }, { id: 'b', toolName: 'Bash', inputSummary: '', rule: 'r2', at: NOW }] })])
    expect(onlyRun(change(withDenials, 'run-1', { kind: 'denial-dismissed', id: 'a' }).ticket).denials.map((d) => d.id)).toEqual(['b'])
    expect(onlyRun(change(withDenials, 'run-1', { kind: 'denials-cleared', rule: 'r2' }).ticket).denials.map((d) => d.id)).toEqual(['a'])
  })

  it('an unknown run id is moved', () => {
    expect(applyRunChange(held, { kind: 'run', runId: 'nope', change: { kind: 'cleared' } }, LATER)).toEqual({ ok: false, reason: 'moved' })
  })

  it('writes no history row and leaves rev alone, except to bind a run to the claim', () => {
    const quiet = change(held, 'run-1', { kind: 'joined', at: LATER }).ticket
    expect(quiet.rev).toBe(held.rev)
    expect(quiet.history).toEqual(held.history)

    const claimed = running(null)
    const started = applyRunChange(claimed, { kind: 'run-start', run: runOf() }, LATER)
    expect(started).toMatchObject({ ok: true, ticket: { rev: claimed.rev + 1, status: { kind: 'running', runId: 'run-1' }, history: claimed.history } })
  })

  it.each([
    ['a ticket queued rather than running', ticketOf({ stage: 'implement' })],
    ['a running ticket at another stage', ticketOf({ stage: 'review', status: { kind: 'running', runId: null } })],
    ['a ticket already bound to a run', running('other')],
  ])('run-start does not bind %s', (_name, ticket) => {
    const result = applyRunChange(ticket, { kind: 'run-start', run: runOf() }, LATER)
    expect(result).toMatchObject({ ok: true, ticket: { rev: ticket.rev, status: ticket.status } })
  })

  it('run-start of a run that ended on arrival, a failed launch, binds nothing', () => {
    const failed = runOf({ sessionKey: null, worktree: null, endedAt: NOW, failure: 'no worktree' })
    expect(applyRunChange(running(null), { kind: 'run-start', run: failed }, LATER)).toMatchObject({ ticket: { status: { kind: 'running', runId: null } } })
  })

  it('run-start replaces a run holding the same id, and keeps the newest runs, never an open or interrupted one', () => {
    const closed = (n: number) => runOf({ id: `old-${String(n)}`, endedAt: NOW, outcome: 'completed' })
    const crowded = running(null, [runOf({ id: 'open', endedAt: null }), runOf({ id: 'held', endedAt: NOW, interruption: { reason: 'crash', detail: null, at: NOW, resetsAt: null } }), ...Array.from({ length: RUN_CAP }, (_unused, n) => closed(n))])
    const result = applyRunChange(crowded, { kind: 'run-start', run: runOf({ id: 'new' }) }, LATER)
    if (!result.ok) throw new Error('refused')
    const ids = result.ticket.runs.map((r) => r.id)
    expect(ids).toHaveLength(RUN_CAP)
    expect(ids).toEqual(expect.arrayContaining(['open', 'held', 'new']))
    expect(ids).not.toContain('old-0')
    expect(applyRunChange(result.ticket, { kind: 'run-start', run: runOf({ id: 'new', claudeSessionId: 'sdk' }) }, LATER)).toMatchObject({ ticket: { runs: expect.arrayContaining([expect.objectContaining({ id: 'new', claudeSessionId: 'sdk' })]) as Run[] } })
  })

  it('applyEvent routes run events to this table', () => {
    const result = applyEvent(held, { kind: 'run', runId: 'run-1', change: { kind: 'joined', at: LATER } }, { at: LATER, actor: null, repo: REPO, ref: { kind: 'issue', number: 843 } })
    expect(result).toMatchObject({ ok: true, changed: true })
  })
})

describe('the projections', () => {
  it('interruptedOf reads a run as the Needs-you row: a run with no interruption reads as crash, a failed launch has none', () => {
    const ticket = running('run-1')
    expect(interruptedOf(ticket, runOf({ title: '#1 x', costUsd: 2 }))).toMatchObject({ id: 'run-1', repoId: REPO, reason: 'crash', inFlight: 'inProgress', title: '#1 x', interruptedAt: NOW, networkRetries: 0 })
    expect(interruptedOf(ticket, runOf({ interruption: { reason: 'network', detail: 'd', at: LATER, resetsAt: LATER }, networkRetries: 2 }))).toMatchObject({ reason: 'network', detail: 'd', resetsAt: LATER, interruptedAt: LATER, networkRetries: 2 })
    expect(interruptedOf(ticket, runOf({ worktree: null }))).toBeNull()
  })

  it.each([
    ['a failed launch', runOf({ sessionKey: null, worktree: null, endedAt: NOW, failure: 'no worktree' }), { state: 'failed', detail: 'no worktree', outcome: null }],
    ['an open run', runOf(), { state: 'started', endedAt: null, outcome: null }],
    ['an ended run with no outcome', runOf({ endedAt: LATER }), { state: 'ended', endedAt: LATER, outcome: null }],
    ['a completed run', runOf({ endedAt: LATER, outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' } }), { state: 'ended', outcome: { kind: 'completed', handback: { token: 'pr-opened', arg: '#8' } } }],
    ['an interruption with no outcome', runOf({ endedAt: LATER, interruption: { reason: 'crash', detail: null, at: LATER, resetsAt: null } }), { state: 'ended', outcome: { kind: 'interrupted' } }],
  ])('dispatchRecordOf reads %s', (_name, run, expected) => {
    expect(dispatchRecordOf(run)).toMatchObject({ runId: run.id, at: run.startedAt, ...expected })
  })

  it('outcomeOf is null while the run is undecided', () => {
    expect(outcomeOf(runOf())).toBeNull()
  })

  it('denialsOf keeps the newest denial per rule across the repository, the last twenty, oldest first', () => {
    const denial = (id: string, rule: string, at: string) => ({ id, toolName: 'Bash', inputSummary: '', rule, at })
    const first = ticketOf({ ticket: 1, runs: [runOf({ id: 'r1', denials: [denial('old', 'same', '2026-11-23T10:00:00.000Z'), denial('only', 'solo', '2026-11-23T10:30:00.000Z')] })] })
    const second = ticketOf({ ticket: 2, runs: [runOf({ id: 'r2', item: { kind: 'issue', number: 2 }, denials: [denial('new', 'same', '2026-11-23T11:00:00.000Z')] })] })
    expect(denialsOf([first, second]).map((d) => d.id)).toEqual(['only', 'new'])

    const many = ticketOf({ runs: [runOf({ denials: Array.from({ length: 20 }, (_unused, n) => denial(`d${String(n)}`, `rule-${String(n)}`, `2026-11-23T10:${String(n).padStart(2, '0')}:00.000Z`)) }), runOf({ id: 'r2', denials: [denial('extra', 'extra', '2026-11-23T12:00:00.000Z')] })] })
    const kept = denialsOf([many])
    expect(kept).toHaveLength(20)
    expect(kept.map((d) => d.id)).not.toContain('d0')
  })
})

describe('recoverRuns', () => {
  it('marks a run open at boot crash, and leaves a finished, interrupted or failed one alone', () => {
    const tickets = [
      ticketOf({ ticket: 1, runs: [runOf({ id: 'open' }), runOf({ id: 'done', endedAt: NOW, outcome: 'completed' }), runOf({ id: 'held', endedAt: NOW, interruption: { reason: 'quit', detail: null, at: NOW, resetsAt: null } }), runOf({ id: 'failed', sessionKey: null, worktree: null, endedAt: NOW, failure: 'x' })] }),
    ]
    expect(recoverRuns(tickets).changes.map((c) => [c.runId, c.change.kind])).toEqual([['open', 'interrupted']])
  })

  it('replays a completed hand-back whose ticket still runs it, but never a plan file or a ticket that moved on', () => {
    const done = (token: string) => runOf({ id: 'run-1', endedAt: NOW, outcome: 'completed', handback: { token, arg: null } })
    expect(recoverRuns([running('run-1', [done('pr-opened')])]).replays.map((r) => r.run.id)).toEqual(['run-1'])
    expect(recoverRuns([running('run-1', [done('plan-written')])]).replays).toEqual([])
    expect(recoverRuns([ticketOf({ stage: 'review', runs: [done('pr-opened')] })]).replays).toEqual([])
    expect(recoverRuns([running('other', [done('pr-opened')])]).replays).toEqual([])
    expect(recoverRuns([running('run-1', [{ ...done('pr-opened'), sessionKey: null }])]).replays).toEqual([])
  })
})

describe('unmatchedClaimOf — the stall ladder', () => {
  const ended = (overrides: Partial<Run> = {}) => runOf({ id: 'a', startedAt: '2026-11-23T10:00:00.000Z', endedAt: '2026-11-23T10:10:00.000Z', ...overrides })
  const AFTER = '2026-11-23T11:00:00.000Z'

  it.each([
    ['no runs', [], AFTER, 'no-record'],
    ['only a run that never launched', [ended({ sessionKey: null })], AFTER, 'no-record'],
    ['only a run at another stage', [ended({ stage: 'review' })], AFTER, 'no-record'],
    ['a run still unended', [ended({ endedAt: null })], AFTER, 'suspect'],
    ['a read that is unknown', [ended()], null, 'suspect'],
    ['a read from before the run ended', [ended()], '2026-11-23T10:05:00.000Z', 'suspect'],
    ['a read too soon after the end to be evidence', [ended()], '2026-11-23T10:10:30.000Z', 'suspect'],
    ['a run that ended with no hand-back, on a fresh read', [ended()], AFTER, 'reset'],
    ['a run that handed back', [ended({ handback: { token: 'pr-opened', arg: '#8' } })], AFTER, 'capped'],
    ['a second run ended with no hand-back in the same visit', [ended(), ended({ id: 'b', startedAt: '2026-11-23T10:20:00.000Z', endedAt: '2026-11-23T10:30:00.000Z' })], AFTER, 'capped'],
    ['an earlier visit to the stage that stalled once, then another stage, then a new first stall', [ended({ id: 'early' }), ended({ id: 'mid', stage: 'review', startedAt: '2026-11-23T10:12:00.000Z', endedAt: '2026-11-23T10:15:00.000Z' }), ended({ id: 'late', startedAt: '2026-11-23T10:20:00.000Z', endedAt: '2026-11-23T10:30:00.000Z' })], AFTER, 'reset'],
  ] as const)('reads %s as %s', (_name, runs, readAt, expected) => {
    expect(unmatchedClaimOf([...runs], 'implement', readAt)).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import { budgetLiveSets, budgetRoute, dispatchArgs, escalationBody, parseSweepLine, parseVerdict, resetArgs, sweepArgs } from './budget'
import type { DispatchRecord } from '../../shared/dispatch/types'
import type { HostedTask } from '../../shared/hosting/types'
import type { TickActionable } from '../../shared/tick/types'

function task(overrides: Partial<HostedTask> = {}): HostedTask {
  return { taskId: 't1', toolUseId: null, description: 'impl #52', subagentType: 'port:impl-agent', status: 'started', startedAt: '2026-09-05T14:00:05.000Z', endedAt: null, ...overrides }
}

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return { agent: 'impl', number: 52, kind: 'issue', state: 'sent', at: '2026-09-05T14:00:00.000Z', ...overrides }
}

describe('resetArgs / sweepArgs / dispatchArgs', () => {
  it('resetArgs names the session', () => {
    expect(resetArgs()).toEqual(['reset', '--session', 'desktop'])
  })

  it('sweepArgs passes empty strings for empty live/completed', () => {
    expect(sweepArgs({ live: [], completed: [] })).toEqual(['sweep', '--live', '', '--completed', '', '--session', 'desktop'])
  })

  it('sweepArgs joins multiple descriptions with a comma', () => {
    expect(sweepArgs({ live: ['impl #52', 'plan #7'], completed: ['review #9'] })).toEqual([
      'sweep',
      '--live',
      'impl #52,plan #7',
      '--completed',
      'review #9',
      '--session',
      'desktop',
    ])
  })

  it('dispatchArgs uses --issue for an issue candidate', () => {
    const candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'> = { kind: 'issue', number: 52, agent: 'impl' }
    expect(dispatchArgs(candidate, 'sonnet')).toEqual(['dispatch', '--issue', '52', '--stage', 'impl', '--model', 'sonnet', '--session', 'desktop'])
  })

  it('dispatchArgs uses --pr for a pull-request candidate, with its own number', () => {
    const candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'> = { kind: 'pull-request', number: 213, agent: 'review' }
    expect(dispatchArgs(candidate, 'opus')).toEqual(['dispatch', '--pr', '213', '--stage', 'review', '--model', 'opus', '--session', 'desktop'])
  })
})

describe('parseVerdict', () => {
  it('parses the verdict and human line from the first two lines', () => {
    expect(parseVerdict('allow\n✅ #52 dispatch allowed — 3m 00s of its 120m ceiling used.\n')).toEqual({
      verdict: 'allow',
      line: '✅ #52 dispatch allowed — 3m 00s of its 120m ceiling used.',
    })
  })

  it('returns null for an unrecognized first line', () => {
    expect(parseVerdict('FAIL  something went wrong\n')).toBeNull()
  })
})

describe('parseSweepLine', () => {
  it('reads the last Budget line, bold markers stripped', () => {
    const stdout = "note  unparseable entry 'bad' — treating it as not live\n**Budget:** session 2 dispatches · 41m 12s agent wall-clock\n"
    expect(parseSweepLine(stdout)).toBe('session 2 dispatches · 41m 12s agent wall-clock')
  })

  it('returns null when no Budget line is present', () => {
    expect(parseSweepLine('note  no dispatches this session\n')).toBeNull()
  })
})

describe('budgetRoute', () => {
  it('allow dispatches and resets the hold streak', () => {
    expect(budgetRoute('allow', 3)).toEqual({ action: 'dispatch', holds: 0 })
  })

  it('exceeded escalates and resets the hold streak', () => {
    expect(budgetRoute('exceeded', 0)).toEqual({ action: 'escalate', holds: 0 })
  })

  it('a first hold holds this pass', () => {
    expect(budgetRoute('hold', 0)).toEqual({ action: 'hold', holds: 1 })
  })

  it('a second consecutive hold dispatches anyway and resets the streak', () => {
    expect(budgetRoute('hold', 1)).toEqual({ action: 'dispatch', holds: 0 })
  })
})

describe('budgetLiveSets', () => {
  it('a started task is live', () => {
    const { live } = budgetLiveSets([task({ status: 'started' })], [])
    expect(live).toContain('impl #52')
  })

  it('a sent record with no confirming task yet is still live', () => {
    const { live } = budgetLiveSets([], [record({ state: 'sent' })])
    expect(live).toContain('impl #52')
  })

  it('a completed task not covered by a live record is completed', () => {
    const { completed, live } = budgetLiveSets([task({ status: 'completed', startedAt: '2026-09-05T14:00:05.000Z' })], [])
    expect(completed).toEqual(['impl #52'])
    expect(live).not.toContain('impl #52')
  })

  it('only the newest task per description decides completed vs live', () => {
    const tasks = [
      task({ taskId: 't1', status: 'completed', startedAt: '2026-09-05T14:00:00.000Z' }),
      task({ taskId: 't2', status: 'started', startedAt: '2026-09-05T14:05:00.000Z' }),
    ]
    const { live, completed } = budgetLiveSets(tasks, [])
    expect(live).toContain('impl #52')
    expect(completed).not.toContain('impl #52')
  })
})

describe('escalationBody', () => {
  it('carries the script line verbatim and names the app as the stopping point', () => {
    const body = escalationBody('⛔ #52 has consumed 2h 00m of agent wall-clock against a 120m ceiling — escalate instead of dispatching impl #52.')
    expect(body).toContain('## Pipeline Escalation')
    expect(body).toContain('⛔ #52 has consumed 2h 00m')
    expect(body).toContain("This app's dispatcher stopped here")
  })
})

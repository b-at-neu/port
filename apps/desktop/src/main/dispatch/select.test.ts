import { describe, expect, it } from 'vitest'
import { REDISPATCH_FLOOR_MS, confirmStarted, markUnconfirmed, selectDispatches } from './select'
import type { DispatchRecord } from '../../shared/dispatch/types'
import type { HostedTask } from '../../shared/hosting/types'
import type { TickActionable } from '../../shared/tick/types'

function actionable(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return { agent: 'impl', number: 52, kind: 'issue', state: 'sent', at: '2026-09-05T14:00:00.000Z', ...overrides }
}

function task(overrides: Partial<HostedTask> = {}): HostedTask {
  return { taskId: 't1', toolUseId: null, description: 'impl #52', subagentType: 'port:impl-agent', status: 'started', startedAt: '2026-09-05T14:00:05.000Z', endedAt: null, ...overrides }
}

describe('selectDispatches', () => {
  it('passes through a candidate with no recent record at all', () => {
    const result = selectDispatches({ dispatchable: [actionable()], recent: [], now: new Date('2026-09-05T14:00:00.000Z') })
    expect(result).toHaveLength(1)
  })

  it('drops a candidate dispatched within the redispatch floor', () => {
    const recent = [record({ at: '2026-09-05T14:00:00.000Z' })]
    const now = new Date(Date.parse('2026-09-05T14:00:00.000Z') + REDISPATCH_FLOOR_MS - 1)
    const result = selectDispatches({ dispatchable: [actionable()], recent, now })
    expect(result).toHaveLength(0)
  })

  it('passes a candidate through once the redispatch floor has elapsed', () => {
    const recent = [record({ at: '2026-09-05T14:00:00.000Z' })]
    const now = new Date(Date.parse('2026-09-05T14:00:00.000Z') + REDISPATCH_FLOOR_MS)
    const result = selectDispatches({ dispatchable: [actionable()], recent, now })
    expect(result).toHaveLength(1)
  })

  it('applies the floor to a confirmed started record, not only a sent one', () => {
    const recent = [record({ state: 'started', at: '2026-09-05T14:00:00.000Z' })]
    const now = new Date(Date.parse('2026-09-05T14:00:00.000Z') + 1000)
    const result = selectDispatches({ dispatchable: [actionable()], recent, now })
    expect(result).toHaveLength(0)
  })

  it('never matches a record for a different agent or number', () => {
    const recent = [record({ agent: 'review', at: '2026-09-05T14:00:00.000Z' }), record({ number: 99, at: '2026-09-05T14:00:00.000Z' })]
    const now = new Date('2026-09-05T14:00:01.000Z')
    const result = selectDispatches({ dispatchable: [actionable()], recent, now })
    expect(result).toHaveLength(1)
  })

  it('uses the newest of several matching records, not an arbitrary one', () => {
    const recent = [record({ at: '2026-09-05T13:00:00.000Z' }), record({ at: '2026-09-05T14:00:00.000Z' })]
    const now = new Date(Date.parse('2026-09-05T14:00:00.000Z') + 1000)
    const result = selectDispatches({ dispatchable: [actionable()], recent, now })
    expect(result).toHaveLength(0)
  })
})

describe('confirmStarted', () => {
  it('moves a sent record to started when a matching task exists', () => {
    const result = confirmStarted([record()], [task()])
    expect(result.updated[0]?.state).toBe('started')
    expect(result.newlyStarted).toHaveLength(1)
  })

  it('leaves a sent record unchanged when no task matches', () => {
    const result = confirmStarted([record()], [])
    expect(result.updated[0]?.state).toBe('sent')
    expect(result.newlyStarted).toHaveLength(0)
  })

  it('never matches on description alone without the subagentType', () => {
    const result = confirmStarted([record()], [task({ subagentType: 'port:review-agent' })])
    expect(result.updated[0]?.state).toBe('sent')
  })

  it('never matches on subagentType alone without the description', () => {
    const result = confirmStarted([record()], [task({ description: 'impl #99' })])
    expect(result.updated[0]?.state).toBe('sent')
  })

  it('passes through a record already started or not-started unchanged', () => {
    const started = record({ state: 'started' })
    const notStarted = record({ state: 'not-started' })
    const result = confirmStarted([started, notStarted], [task()])
    expect(result.updated).toEqual([started, notStarted])
    expect(result.newlyStarted).toHaveLength(0)
  })
})

describe('markUnconfirmed', () => {
  it('turns a sent record into not-started', () => {
    const result = markUnconfirmed([record()])
    expect(result[0]?.state).toBe('not-started')
  })

  it('never touches a started or already not-started record', () => {
    const started = record({ state: 'started' })
    const notStarted = record({ state: 'not-started' })
    const result = markUnconfirmed([started, notStarted])
    expect(result).toEqual([started, notStarted])
  })
})

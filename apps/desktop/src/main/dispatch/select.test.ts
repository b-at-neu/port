import { describe, expect, it } from 'vitest'
import { REDISPATCH_FLOOR_MS, selectDispatches } from './select'
import type { StageRecord } from './launch'
import type { SessionKey } from '../../shared/hosting/types'
import type { TickActionable } from '../../shared/tick/types'

function actionable(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

function record(overrides: Partial<StageRecord> = {}): StageRecord {
  return { sessionKey: 'hosted-1' as SessionKey, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', state: 'started', at: '2026-09-05T14:00:00.000Z', detail: null, ...overrides }
}

describe('selectDispatches', () => {
  it('passes through a candidate with no recent record at all', () => {
    const result = selectDispatches({ dispatchable: [actionable()], recent: [], now: new Date('2026-09-05T14:00:00.000Z') })
    expect(result).toHaveLength(1)
  })

  it('drops a candidate launched within the redispatch floor', () => {
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

  it('applies the floor to a failed record too, not only a started one', () => {
    const recent = [record({ state: 'failed', detail: 'boom', at: '2026-09-05T14:00:00.000Z' })]
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

import { describe, expect, it } from 'vitest'
import { ticketViewOfItem } from '@/utils/pipeline/stages'
import { NOW, ticketAt } from '../../../support/tickets'

describe('ticketViewOfItem', () => {
  const ticket = ticketAt('review', { kind: 'running', runId: 'run-1' })

  it.each([
    { name: 'an untracked item has no view', item: { ticket: null, mergedAt: null }, view: null },
    { name: 'a tracked item reads its ticket', item: { ticket, mergedAt: null }, view: { stage: 'review', status: { kind: 'running' } } },
    { name: 'a merged item reads done even before its ticket caught up', item: { ticket, mergedAt: NOW }, view: { stage: 'merge', status: { kind: 'done' } } },
    { name: 'a merged untracked item still reads done', item: { ticket: null, mergedAt: NOW }, view: { stage: 'merge', status: { kind: 'done' } } },
  ])('$name', ({ item, view }) => {
    const result = ticketViewOfItem(item)
    if (view === null) expect(result).toBeNull()
    else expect(result).toMatchObject(view)
  })
})

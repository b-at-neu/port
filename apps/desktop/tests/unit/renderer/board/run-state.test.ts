import { describe, expect, it } from 'vitest'
import { undoCommandFor } from '@/renderer/board/run-state'

describe('undoCommandFor', () => {
  it.each([
    ['dispatching', 'run', null],
    ['draining', 'run', 'drain'],
    ['paused', 'run', 'pause'],
    [null, 'run', null],
    ['dispatching', 'drain', 'run'],
    ['draining', 'drain', null],
    ['paused', 'drain', null],
    [null, 'drain', null],
  ] as const)('after %s then %s it returns %s', (prior, command, expected) => {
    expect(undoCommandFor(prior, command)).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import { isLiveStageSession } from '@/utils/stage/live'

describe('isLiveStageSession', () => {
  it.each(['starting', 'ready', 'streaming', 'interrupting'] as const)('holds its item while %s', (phase) => {
    expect(isLiveStageSession({ phase })).toBe(true)
  })

  it.each(['closing', 'ended'] as const)('no longer holds its item while %s', (phase) => {
    expect(isLiveStageSession({ phase })).toBe(false)
  })
})

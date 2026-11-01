import { describe, expect, it } from 'vitest'
import { sessionMarkItems } from '@/renderer/session/marks-menu-model'

const NO_MARKS = { pinned: [], archived: [] }

describe('sessionMarkItems', () => {
  it('lists Rename first only when the row can rename', () => {
    expect(sessionMarkItems({ sessionId: 's1', marks: NO_MARKS, canRename: true }).map((item) => item.key)).toEqual(['rename', 'pin', 'archive'])
    expect(sessionMarkItems({ sessionId: 's1', marks: NO_MARKS, canRename: false }).map((item) => item.key)).toEqual(['pin', 'archive'])
  })

  it('disables Pin and Archive, never Rename, without a session id', () => {
    const items = sessionMarkItems({ sessionId: null, marks: NO_MARKS, canRename: true })
    expect(items.map((item) => item.disabled)).toEqual([false, true, true])
  })

  it('flips the labels for a pinned and archived session', () => {
    const items = sessionMarkItems({ sessionId: 's1', marks: { pinned: ['s1'], archived: ['s1'] }, canRename: false })
    expect(items.map((item) => item.label)).toEqual(['Unpin', 'Unarchive'])
  })

  it('reads the unmarked labels while marks are still loading', () => {
    const items = sessionMarkItems({ sessionId: 's1', marks: undefined, canRename: false })
    expect(items.map((item) => item.label)).toEqual(['Pin', 'Archive'])
  })
})

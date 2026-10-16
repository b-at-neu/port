import { describe, expect, it } from 'vitest'
import { groupHistory } from '@/renderer/history/model'
import type { SessionRecord } from '@/types/sessions'

function record(sessionId: string): SessionRecord {
  return {
    sessionId,
    repoId: null,
    cwd: null,
    worktreePath: null,
    role: 'other',
    roleEvidence: null,
    itemNumber: null,
    customTitle: null,
    summary: null,
    firstPrompt: null,
    gitBranch: null,
    lastActivityAt: new Date(0).toISOString(),
    idleMs: 0,
    activity: 'dormant',
    agentIds: [],
  }
}

const A = record('a')
const B = record('b')
const C = record('c')

describe('groupHistory', () => {
  it('puts everything in recent when marks are empty', () => {
    expect(groupHistory([A, B], { pinned: [], archived: [] }, false)).toEqual({ pinned: [], recent: [A, B], archived: [] })
  })

  it('groups a pinned session separately, keeping incoming order', () => {
    expect(groupHistory([A, B, C], { pinned: ['b'], archived: [] }, false)).toEqual({ pinned: [B], recent: [A, C], archived: [] })
  })

  it('hides an archived session unless showArchived is set', () => {
    expect(groupHistory([A, B], { pinned: [], archived: ['b'] }, false)).toEqual({ pinned: [], recent: [A], archived: [] })
    expect(groupHistory([A, B], { pinned: [], archived: ['b'] }, true)).toEqual({ pinned: [], recent: [A], archived: [B] })
  })

  it('sends an archived-and-pinned session to archived, never to pinned', () => {
    expect(groupHistory([A, B], { pinned: ['b'], archived: ['b'] }, true)).toEqual({ pinned: [], recent: [A], archived: [B] })
  })
})

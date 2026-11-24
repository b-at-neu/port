import { describe, expect, it } from 'vitest'
import { groupHistory, historyView } from '@/renderer/history/model'
import type { SessionMarks } from '@/types/hosting'
import type { AgentRecord, MetaProblem, SessionRecord, SessionRef, SessionScan } from '@/types/sessions'
import type { RepoId } from '@/utils/repos'

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

const REPO_ONE = 'repo-one' as RepoId
const REPO_TWO = 'repo-two' as RepoId

function inRepo(sessionId: string, repoId: RepoId, idleMs = 0): SessionRecord {
  return { ...record(sessionId), repoId, idleMs }
}

function agent(sessionId: string, repoId: RepoId | null): AgentRecord {
  return { sessionId, repoId, agentId: `${sessionId}-agent`, agentType: 'plan-agent', stage: null, model: null, description: null, itemNumber: null, worktreePath: null, worktreeBranch: null, spawnDepth: null, lastActivityAt: new Date(0).toISOString(), idleMs: 0, activity: 'dormant' }
}

function scan(sessions: readonly SessionRecord[], agents: readonly AgentRecord[] = [], gaps: { unresolved?: number; unreadable?: number } = {}): SessionScan {
  const unresolved: SessionRef[] = Array.from({ length: gaps.unresolved ?? 0 }, (_, i) => ({ sessionId: `u${String(i)}` }))
  const unreadable: MetaProblem[] = Array.from({ length: gaps.unreadable ?? 0 }, (_, i) => ({ sessionId: `r${String(i)}`, agentId: 'x', kind: 'malformed', message: 'bad' }))
  return { ok: true, sessions, agents, unattributed: 0, unresolved, unreadable, scannedProjects: 1, scanMs: 1, scannedAt: new Date(0).toISOString() }
}

const NO_MARKS: SessionMarks = { pinned: [], archived: [] }

describe('historyView', () => {
  it('fails on a typed scan failure', () => {
    expect(historyView({ ok: false, kind: 'sdk-failed', message: 'boom', scannedAt: new Date(0).toISOString() }, { repo: null, marks: NO_MARKS, showArchived: false }).kind).toBe('failed')
  })

  it.each([
    ['no sessions at all', scan([]), null, NO_MARKS, false, 'empty'],
    ['none in the filtered repository', scan([inRepo('a', REPO_ONE)]), REPO_TWO, NO_MARKS, false, 'empty'],
    ['every session archived, hidden', scan([A, B]), null, { pinned: [], archived: ['a', 'b'] }, false, 'all-archived'],
    ['every session archived, shown', scan([A, B]), null, { pinned: [], archived: ['a', 'b'] }, true, 'list'],
    ['marks not loaded yet', scan([A]), null, undefined, false, 'list'],
  ] as const)('%s is %s', (_name, input, repo, marks, showArchived, kind) => {
    expect(historyView(input, { repo, marks, showArchived }).kind).toBe(kind)
  })

  it('shows no group headers for one group, and headers for several', () => {
    const one = historyView(scan([A, B]), { repo: null, marks: NO_MARKS, showArchived: false })
    const several = historyView(scan([A, B]), { repo: null, marks: { pinned: ['a'], archived: [] }, showArchived: false })
    expect(one).toMatchObject({ kind: 'list', showHeaders: false })
    expect(several).toMatchObject({ kind: 'list', showHeaders: true })
    expect(several.kind === 'list' ? several.groups.map((group) => group.kind) : []).toEqual(['pinned', 'recent'])
  })

  it('sorts each group by how recently it was active', () => {
    const view = historyView(scan([inRepo('old', REPO_ONE, 900), inRepo('new', REPO_ONE, 5)]), { repo: null, marks: NO_MARKS, showArchived: false })
    expect(view.kind === 'list' ? view.groups[0]?.rows.map((row) => row.sessionId) : []).toEqual(['new', 'old'])
  })

  it('keeps only the filtered repository’s agents', () => {
    const view = historyView(scan([inRepo('a', REPO_ONE), inRepo('b', REPO_TWO)], [agent('a', REPO_ONE), agent('b', REPO_TWO)]), { repo: REPO_ONE, marks: NO_MARKS, showArchived: false })
    expect(view.kind === 'list' ? [...view.agentsBySession.keys()] : []).toEqual(['a'])
  })

  it('carries a footnote only when something went unresolved or unreadable', () => {
    const clean = historyView(scan([A]), { repo: null, marks: NO_MARKS, showArchived: false })
    const gaps = historyView(scan([A], [], { unresolved: 1 }), { repo: null, marks: NO_MARKS, showArchived: false })
    expect(clean.kind === 'list' ? clean.note : 'x').toBeNull()
    expect(gaps.kind === 'list' ? gaps.note : null).not.toBeNull()
  })
})

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

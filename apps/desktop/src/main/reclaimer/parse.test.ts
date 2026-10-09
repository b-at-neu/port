import { describe, expect, it } from 'vitest'
import { createPathOps } from '../platform/paths'
import { parseReclaimPayload, parseReportPayload } from './parse'

const posixPathOps = createPathOps('posix', { home: '/home/op' })
const win32PathOps = createPathOps('win32', { home: 'C:\\Users\\op' })

interface RawCandidate {
  path: unknown
  branch: unknown
  head: unknown
  state: unknown
  reason: unknown
  rung: unknown
  issue: unknown
  locked: unknown
  lockReason: unknown
  dirtyFiles: unknown
  removed: unknown
  branchDeleted: unknown
  error: unknown
}

interface RawPayload {
  mainRoot: unknown
  integrationRef: unknown
  candidates: unknown
  orphanDirs: unknown
  summary: unknown
}

function basePayload(): RawPayload {
  const candidate: RawCandidate = {
    path: '/repo/.claude/worktrees/impl-42',
    branch: '42-feature',
    head: 'deadbeef',
    state: 'done',
    reason: '#42 merged (branch-name)',
    rung: 'branch-name',
    issue: 42,
    locked: false,
    lockReason: null,
    dirtyFiles: 0,
    removed: false,
    branchDeleted: null,
    error: null,
  }
  return {
    mainRoot: '/repo',
    integrationRef: 'origin/dev',
    candidates: [candidate],
    orphanDirs: [],
    summary: { registered: 1, removed: 0, kept: 1, byState: { done: 1 } },
  }
}

function firstCandidate(payload: RawPayload): RawCandidate {
  return (payload.candidates as RawCandidate[])[0] as RawCandidate
}

describe('parseReportPayload', () => {
  it('parses a full payload', () => {
    const result = parseReportPayload(JSON.stringify(basePayload()), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mainRoot).toBe('/repo')
    expect(result.integrationRef).toBe('origin/dev')
    expect(result.registered).toBe(1)
    expect(result.byState).toEqual({ done: 1 })
    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toEqual({
      path: '/repo/.claude/worktrees/impl-42',
      branch: '42-feature',
      head: 'deadbeef',
      state: 'done',
      reason: '#42 merged (branch-name)',
      issue: 42,
      rung: 'branch-name',
      locked: false,
      lockReason: null,
      dirtyFiles: 0,
    })
  })

  it('fails on an unknown state, naming the candidate', () => {
    const payload = basePayload()
    firstCandidate(payload).state = 'quarantined'
    const result = parseReportPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('candidates[0].state')
    expect(result.message).toContain('quarantined')
  })

  it('fails when candidates is missing', () => {
    const payload = basePayload()
    delete (payload as { candidates?: unknown }).candidates
    const result = parseReportPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('candidates')
  })

  it('fails when candidates is not an array', () => {
    const payload = basePayload()
    payload.candidates = { not: 'an array' }
    const result = parseReportPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(false)
  })

  it('fails on a non-object stdout', () => {
    const result = parseReportPayload('"just a string"', posixPathOps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('JSON object')
  })

  it('fails on unparseable JSON', () => {
    const result = parseReportPayload('not json at all', posixPathOps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('valid JSON')
  })

  it('preserves dirtyFiles: -1, the script\'s "unknown count" sentinel', () => {
    const payload = basePayload()
    firstCandidate(payload).dirtyFiles = -1
    const result = parseReportPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.worktrees[0]?.dirtyFiles).toBe(-1)
  })

  it('normalizes a Windows-shaped path to native win32 form', () => {
    const payload = basePayload()
    payload.mainRoot = 'C:/Users/op/repo'
    firstCandidate(payload).path = 'C:/Users/op/repo/.claude/worktrees/impl-42'
    const result = parseReportPayload(JSON.stringify(payload), win32PathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mainRoot).toBe('C:\\Users\\op\\repo')
    expect(result.worktrees[0]?.path).toBe('C:\\Users\\op\\repo\\.claude\\worktrees\\impl-42')
  })

  it('orphanDirs empty is accepted', () => {
    const payload = basePayload()
    payload.orphanDirs = []
    const result = parseReportPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.orphanDirs).toEqual([])
  })

  it('orphanDirs populated is normalized through pathOps', () => {
    const payload = basePayload()
    payload.orphanDirs = ['/repo/.claude/worktrees/junk']
    const result = parseReportPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.orphanDirs).toEqual(['/repo/.claude/worktrees/junk'])
  })
})

describe('parseReclaimPayload', () => {
  it('classifies a removed candidate', () => {
    const payload = basePayload()
    firstCandidate(payload).removed = true
    firstCandidate(payload).branchDeleted = true
    const result = parseReclaimPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(1)
    expect(result.results).toEqual([
      { path: '/repo/.claude/worktrees/impl-42', pathBasename: 'impl-42', issue: 42, outcome: 'removed', error: null, branchDeleted: true },
    ])
  })

  it('classifies a failed candidate from a non-null error', () => {
    const payload = basePayload()
    firstCandidate(payload).removed = false
    firstCandidate(payload).error = 'a review session is still attached'
    const result = parseReclaimPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(0)
    expect(result.results[0]?.outcome).toBe('failed')
    expect(result.results[0]?.error).toBe('a review session is still attached')
  })

  it('classifies a kept candidate: not removed, no error', () => {
    const payload = basePayload()
    firstCandidate(payload).removed = false
    firstCandidate(payload).error = null
    const result = parseReclaimPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]?.outcome).toBe('kept')
  })

  it('fails when removed is missing or not a boolean', () => {
    const payload = basePayload()
    delete (firstCandidate(payload) as { removed?: unknown }).removed
    const result = parseReclaimPayload(JSON.stringify(payload), posixPathOps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('removed')
  })

  it('fails on unparseable JSON, the same as parseReportPayload', () => {
    const result = parseReclaimPayload('not json at all', posixPathOps)
    expect(result.ok).toBe(false)
  })
})

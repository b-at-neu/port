import { describe, expect, it } from 'vitest'
import type { AgentRecord, SessionRecord } from '@/types/sessions'
import type { WorktreeEntry } from '@/types/local'
import type { PathOps } from '@/types/platform'
import { createPathOps } from '@/main/platform/paths'
import { attachAgents, attachSessions, attachWorktrees, collectOrphanNumbers, indexWorkSessions, workSessionsFor } from '@/main/state/attach'

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    sessionId: 's1',
    repoId: 'r1' as AgentRecord['repoId'],
    agentId: 'a1',
    agentType: 'port:impl-agent',
    stage: 'impl-agent',
    model: 'sonnet',
    description: 'impl #79',
    itemNumber: 79,
    worktreePath: null,
    worktreeBranch: null,
    spawnDepth: 1,
    lastActivityAt: '2026-01-01T00:00:00Z',
    idleMs: 0,
    activity: 'active',
    ...overrides,
  }
}

function worktreeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: '/repo/.claude/worktrees/agent-abc',
    isMain: false,
    branch: '79-ticket',
    head: 'abc123',
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    producer: 'dispatched',
    insideMain: true,
    correlation: { number: 79, rung: 'branch-name' },
    unresolved: null,
    ...overrides,
  }
}

describe('attachAgents', () => {
  it('a direct number match attaches', () => {
    const attached = attachAgents({ number: 79, linked: null }, [agent()])
    expect(attached).toHaveLength(1)
    expect(attached[0]?.match).toBe('direct')
    expect(attached[0]?.sessionId).toBe('s1')
  })

  it('a review #<pr> agent attaches to the issue via linked, with match: linked', () => {
    const attached = attachAgents({ number: 79, linked: 196 }, [agent({ itemNumber: 196, stage: 'review-agent', description: 'review #196' })])
    expect(attached).toHaveLength(1)
    expect(attached[0]?.match).toBe('linked')
  })

  it('an agent whose itemNumber is null attaches to nothing', () => {
    const attached = attachAgents({ number: 79, linked: null }, [agent({ itemNumber: null, stage: null })])
    expect(attached).toEqual([])
  })

  it('an unrelated number never attaches', () => {
    const attached = attachAgents({ number: 79, linked: null }, [agent({ itemNumber: 5 })])
    expect(attached).toEqual([])
  })
})

describe('attachSessions', () => {
  function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 'sess1',
      repoId: 'r1' as SessionRecord['repoId'],
      cwd: '/repo/.claude/worktrees/impl-79',
      worktreePath: '/repo/.claude/worktrees/impl-79',
      role: 'implement',
      roleEvidence: 'worktree-name',
      itemNumber: 79,
      customTitle: null,
      summary: null,
      firstPrompt: null,
      gitBranch: null,
      lastActivityAt: '2026-01-01T00:00:00Z',
      idleMs: 0,
      activity: 'active',
      agentIds: [],
      ...overrides,
    }
  }

  it('a direct number match attaches', () => {
    const attached = attachSessions({ number: 79, linked: null }, [session()])
    expect(attached).toHaveLength(1)
    expect(attached[0]?.match).toBe('direct')
    expect(attached[0]?.role).toBe('implement')
  })

  it('a session with no itemNumber attaches to nothing', () => {
    const attached = attachSessions({ number: 79, linked: null }, [session({ itemNumber: null, role: 'other', roleEvidence: null })])
    expect(attached).toEqual([])
  })
})

describe('attachWorktrees', () => {
  it('a correlated worktree attaches', () => {
    const attached = attachWorktrees({ number: 79, linked: null }, [worktreeEntry()])
    expect(attached).toHaveLength(1)
    expect(attached[0]?.rung).toBe('branch-name')
  })

  it('a worktree whose unresolved is set never attaches', () => {
    const attached = attachWorktrees({ number: 79, linked: null }, [worktreeEntry({ correlation: null, unresolved: 'no-rung-matched' })])
    expect(attached).toEqual([])
  })
})

describe('attachWorkSessions', () => {
  function work(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 'work1',
      repoId: 'r1' as SessionRecord['repoId'],
      cwd: null,
      worktreePath: null,
      role: 'other',
      roleEvidence: null,
      itemNumber: null,
      customTitle: null,
      summary: null,
      firstPrompt: null,
      gitBranch: null,
      lastActivityAt: '2026-01-01T00:00:00Z',
      idleMs: 0,
      activity: 'idle',
      agentIds: [],
      ...overrides,
    }
  }
  const main = worktreeEntry({ path: '/repo', isMain: true, branch: 'dev', correlation: null, unresolved: 'no-rung-matched' })
  const mine = worktreeEntry({ path: '/repo/.claude/worktrees/x', branch: '79-ticket' })
  const issue = { number: 79, kind: 'issue' as const }
  const matchesOf = (sessions: SessionRecord[], worktrees: WorktreeEntry[], item: { number: number; kind: 'issue' | 'pull-request' } = issue) =>
    workSessionsFor(indexWorkSessions(sessions, worktrees), item)

  it('matches a session whose cwd sits inside the ticket’s worktree', () => {
    const result = matchesOf([work({ cwd: '/repo/.claude/worktrees/x/src' })], [main, mine])
    expect(result.map((s) => s.match)).toEqual(['worktree'])
  })

  it('uses the most specific worktree, so a nested worktree never matches the main checkout’s ticket', () => {
    const mainTicket = worktreeEntry({ path: '/repo', isMain: true, correlation: { number: 5, rung: 'branch-name' } })
    const result = matchesOf([work({ cwd: '/repo/.claude/worktrees/x' })], [mainTicket, mine], { number: 5, kind: 'issue' })
    expect(result).toEqual([])
  })

  it('matches by git branch when the cwd is elsewhere', () => {
    const result = matchesOf([work({ cwd: '/elsewhere', gitBranch: '79-ticket' })], [main, mine])
    expect(result.map((s) => s.match)).toEqual(['branch'])
  })

  it('matches a ticket-label title for an issue and a pull request, never a longer number', () => {
    const titled = (customTitle: string) => work({ customTitle })
    expect(matchesOf([titled('#47 x'), titled('#47'), titled('#470 x'), titled('PR#47 x')], [], { number: 47, kind: 'issue' }).map((s) => s.title)).toEqual(['#47 x', '#47'])
    expect(matchesOf([titled('PR#47 x'), titled('#47 x')], [], { number: 47, kind: 'pull-request' }).map((s) => s.title)).toEqual(['PR#47 x'])
  })

  it('skips cockpit sessions', () => {
    const result = matchesOf([work({ role: 'cockpit', cwd: '/repo/.claude/worktrees/x' })], [main, mine])
    expect(result).toEqual([])
  })

  it('never matches a branch by name pattern', () => {
    const result = matchesOf([work({ cwd: '/elsewhere', gitBranch: '79-other-slug' })], [main, mine])
    expect(result).toEqual([])
  })

  it('a relative cwd or worktree path never owns a session', () => {
    const relative = worktreeEntry({ path: 'relative/x' })
    expect(matchesOf([work({ cwd: 'relative/x' })], [relative])).toEqual([])
    expect(matchesOf([work({ cwd: '/repo/.claude/worktrees/x' })], [relative])).toEqual([])
  })

  it('stays within a path-op budget at scale', () => {
    const calls = { pathKey: 0, dirname: 0 }
    const base = createPathOps('posix', { home: '/home/u' })
    const counting: PathOps = {
      ...base,
      pathKey: (p) => {
        calls.pathKey += 1
        return base.pathKey(p)
      },
      dirname: (p) => {
        calls.dirname += 1
        return base.dirname(p)
      },
    }
    const worktrees = Array.from({ length: 60 }, (_, i) => worktreeEntry({ path: `/repo/.claude/worktrees/w${String(i)}`, branch: `${String(i + 1)}-t`, correlation: { number: i + 1, rung: 'branch-name' } }))
    const sessions = Array.from({ length: 200 }, (_, i) => work({ sessionId: `s${String(i)}`, cwd: `/repo/.claude/worktrees/w${String(i % 60)}/src/deep` }))
    const index = indexWorkSessions(sessions, worktrees, counting)
    let matched = 0
    for (let n = 1; n <= 500; n += 1) matched += workSessionsFor(index, { number: n, kind: 'issue' }).length
    expect(matched).toBe(200)
    const depth = 8
    expect(calls.pathKey + calls.dirname).toBeLessThanOrEqual(worktrees.length + sessions.length * (depth + 2) * 2)
  })
})

describe('collectOrphanNumbers', () => {
  it('a number named only by a worktree lands in the orphan set', () => {
    const orphans = collectOrphanNumbers([{ number: 1 }], [worktreeEntry({ correlation: { number: 999, rung: 'branch-name' } })], [])
    expect(orphans).toEqual([999])
  })

  it('a number named only by an agent lands in the orphan set', () => {
    const orphans = collectOrphanNumbers([{ number: 1 }], [], [agent({ itemNumber: 999 })])
    expect(orphans).toEqual([999])
  })

  it('a number present in the sweep never lands there', () => {
    const orphans = collectOrphanNumbers([{ number: 79 }], [worktreeEntry({ correlation: { number: 79, rung: 'branch-name' } })], [agent({ itemNumber: 79 })])
    expect(orphans).toEqual([])
  })

  it('deduplicates a number named by both a worktree and an agent', () => {
    const orphans = collectOrphanNumbers([], [worktreeEntry({ correlation: { number: 999, rung: 'branch-name' } })], [agent({ itemNumber: 999 })])
    expect(orphans).toEqual([999])
  })
})

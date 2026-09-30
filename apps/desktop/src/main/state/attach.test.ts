import { describe, expect, it } from 'vitest'
import type { AgentRecord, SessionRecord } from '../../shared/sessions/types'
import type { WorktreeEntry } from '../../shared/local/types'
import { attachAgents, attachSessions, attachWorktrees, collectOrphanNumbers } from './attach'

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

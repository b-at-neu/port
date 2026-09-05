import { describe, expect, it } from 'vitest'
import { ACTIVE_WITHIN_MS, IDLE_WITHIN_MS } from '../../shared/sessions/types'
import { attributeSession, activityOf, itemNumberOf, parseAgentMeta, sessionRole, stageOf } from './classify'
import type { RepoRef } from './classify'

const REPO_A = { id: 'repo-a', root: '/home/user/projects/port' } as unknown as RepoRef
const REPO_PORTFOLIO = { id: 'repo-b', root: '/home/user/projects/portfolio' } as unknown as RepoRef

describe('attributeSession', () => {
  it('attributes a cwd equal to the repo root', () => {
    expect(attributeSession([REPO_A], '/home/user/projects/port')).toEqual({ repoId: REPO_A.id, worktreePath: null })
  })

  it('attributes a cwd under a worktree, carrying worktreePath', () => {
    const cwd = '/home/user/projects/port/.claude/worktrees/agent-abc123'
    expect(attributeSession([REPO_A], cwd)).toEqual({ repoId: REPO_A.id, worktreePath: cwd })
  })

  it('does not attribute a sibling directory sharing a name prefix (the startsWith bug contains prevents)', () => {
    expect(attributeSession([REPO_A], '/home/user/projects/portfolio')).toEqual({ repoId: null, worktreePath: null })
  })

  it('a repo list containing the sibling still attributes correctly to each', () => {
    expect(attributeSession([REPO_A, REPO_PORTFOLIO], '/home/user/projects/portfolio/src')).toEqual({
      repoId: REPO_PORTFOLIO.id,
      worktreePath: null,
    })
  })

  it('an unattributed cwd (no registered root contains it) reports null, not a throw', () => {
    expect(attributeSession([REPO_A], '/somewhere/else')).toEqual({ repoId: null, worktreePath: null })
  })

  it('a null cwd is unattributed', () => {
    expect(attributeSession([REPO_A], null)).toEqual({ repoId: null, worktreePath: null })
  })
})

describe('stageOf', () => {
  it('"port:plan-agent" and a bare "plan-agent" both resolve to the same stage', () => {
    expect(stageOf('port:plan-agent')).toBe('plan-agent')
    expect(stageOf('plan-agent')).toBe('plan-agent')
  })

  it('a non-port agent resolves to null', () => {
    expect(stageOf('Explore')).toBeNull()
    expect(stageOf('general-purpose')).toBeNull()
  })

  it('a wildcard prefix before the last colon still resolves', () => {
    expect(stageOf('anything:impl-agent')).toBe('impl-agent')
  })
})

describe('sessionRole', () => {
  it('impl-42 under .claude/worktrees wins over a firstPrompt, capturing the item number', () => {
    const verdict = sessionRole(
      { cwd: '/home/user/projects/port/.claude/worktrees/impl-42', firstPrompt: '/port:pipeline' },
      [],
    )
    expect(verdict).toEqual({ role: 'implement', evidence: 'worktree-name', itemNumber: 42 })
  })

  it('a stage-bearing subagent classifies as cockpit even with no worktree-name rung', () => {
    const verdict = sessionRole({ cwd: '/home/user/projects/port', firstPrompt: null }, ['port:review-agent'])
    expect(verdict).toEqual({ role: 'cockpit', evidence: 'stage-agent', itemNumber: null })
  })

  it('/anything:pipeline classifies as cockpit while /port:pipelinex does not', () => {
    expect(sessionRole({ cwd: null, firstPrompt: '/anything:pipeline' }, [])).toEqual({
      role: 'cockpit',
      evidence: 'first-prompt',
      itemNumber: null,
    })
    expect(sessionRole({ cwd: null, firstPrompt: '/port:pipelinex' }, [])).toEqual({
      role: 'other',
      evidence: null,
      itemNumber: null,
    })
  })

  it('#78 R1-L1: /port:pipeline-old does not match — a hyphen is not a word boundary', () => {
    expect(sessionRole({ cwd: null, firstPrompt: '/port:pipeline-old' }, [])).toEqual({
      role: 'other',
      evidence: null,
      itemNumber: null,
    })
  })

  it('/anything:implement classifies as implement', () => {
    expect(sessionRole({ cwd: null, firstPrompt: '/anything:implement' }, [])).toEqual({
      role: 'implement',
      evidence: 'first-prompt',
      itemNumber: null,
    })
  })

  it('no evidence at all classifies as other', () => {
    expect(sessionRole({ cwd: '/home/user/projects/port', firstPrompt: null }, [])).toEqual({
      role: 'other',
      evidence: null,
      itemNumber: null,
    })
  })

  it('an impl-shaped basename outside .claude/worktrees does not trigger rung 1', () => {
    const verdict = sessionRole({ cwd: '/home/user/projects/impl-42', firstPrompt: null }, [])
    expect(verdict.role).toBe('other')
  })
})

describe('itemNumberOf', () => {
  it('"#0" yields null', () => {
    expect(itemNumberOf('impl-agent #0')).toBeNull()
  })

  it('"revise #130" yields 130', () => {
    expect(itemNumberOf('revise #130')).toBe(130)
  })

  it('null description yields null', () => {
    expect(itemNumberOf(null)).toBeNull()
  })

  it('a description with no number yields null', () => {
    expect(itemNumberOf('general exploration')).toBeNull()
  })
})

describe('activityOf', () => {
  const now = new Date('2024-01-01T12:00:00.000Z')

  it('at the active boundary is active', () => {
    const modifiedAt = new Date(now.getTime() - ACTIVE_WITHIN_MS).toISOString()
    expect(activityOf(modifiedAt, now).activity).toBe('active')
  })

  it('just past the active boundary is idle', () => {
    const modifiedAt = new Date(now.getTime() - ACTIVE_WITHIN_MS - 1).toISOString()
    expect(activityOf(modifiedAt, now).activity).toBe('idle')
  })

  it('at the idle boundary is idle', () => {
    const modifiedAt = new Date(now.getTime() - IDLE_WITHIN_MS).toISOString()
    expect(activityOf(modifiedAt, now).activity).toBe('idle')
  })

  it('just past the idle boundary is dormant', () => {
    const modifiedAt = new Date(now.getTime() - IDLE_WITHIN_MS - 1).toISOString()
    expect(activityOf(modifiedAt, now).activity).toBe('dormant')
  })

  it('reports idleMs as the elapsed milliseconds', () => {
    const modifiedAt = new Date(now.getTime() - 1000).toISOString()
    expect(activityOf(modifiedAt, now).idleMs).toBe(1000)
  })
})

describe('parseAgentMeta', () => {
  it('parses a full record', () => {
    const result = parseAgentMeta({
      agentType: 'port:impl-agent',
      description: 'impl #10',
      model: 'sonnet',
      worktreePath: '/a/b',
      worktreeBranch: 'worktree-agent-abc',
      spawnDepth: 1,
    })
    expect(result).toEqual({
      ok: true,
      value: {
        agentType: 'port:impl-agent',
        description: 'impl #10',
        model: 'sonnet',
        worktreePath: '/a/b',
        worktreeBranch: 'worktree-agent-abc',
        spawnDepth: 1,
      },
    })
  })

  it('defaults every absent optional to null', () => {
    const result = parseAgentMeta({ agentType: 'general-purpose' })
    expect(result).toEqual({
      ok: true,
      value: {
        agentType: 'general-purpose',
        description: null,
        model: null,
        worktreePath: null,
        worktreeBranch: null,
        spawnDepth: null,
      },
    })
  })

  it('a meta.json missing agentType becomes a reported problem, never a throw', () => {
    const result = parseAgentMeta({ description: 'no agent type here' })
    expect(result.ok).toBe(false)
  })

  it('a non-object payload becomes a reported problem', () => {
    expect(parseAgentMeta(null).ok).toBe(false)
    expect(parseAgentMeta('a string').ok).toBe(false)
  })
})

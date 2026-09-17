import { describe, expect, it } from 'vitest'
import type { RepoId } from '../repos'
import type { AgentRecord, SessionRecord } from './types'
import { agentLabel, sessionLabel } from './label'

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'a-session',
    repoId: 'repo-a' as RepoId,
    cwd: '/repo',
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
    activity: 'active',
    agentIds: [],
    ...overrides,
  }
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    sessionId: 'a-session',
    repoId: 'repo-a' as RepoId,
    agentId: 'abc123',
    agentType: 'impl-agent',
    stage: 'impl-agent',
    model: null,
    description: null,
    itemNumber: null,
    worktreePath: null,
    worktreeBranch: null,
    spawnDepth: null,
    lastActivityAt: new Date(0).toISOString(),
    idleMs: 0,
    activity: 'active',
    ...overrides,
  }
}

describe('sessionLabel', () => {
  it('prefers customTitle', () => {
    expect(sessionLabel(session({ customTitle: 'My title', summary: 'summary', firstPrompt: 'prompt' }))).toBe('My title')
  })

  it('falls back to summary, then firstPrompt, then the untitled copy', () => {
    expect(sessionLabel(session({ summary: 'summary', firstPrompt: 'prompt' }))).toBe('summary')
    expect(sessionLabel(session({ firstPrompt: 'prompt' }))).toBe('prompt')
    expect(sessionLabel(session())).toBe('(untitled session)')
  })

  it('cuts at 80 characters with an ellipsis', () => {
    const long = 'x'.repeat(90)
    const label = sessionLabel(session({ customTitle: long }))
    expect(label).toBe(`${'x'.repeat(80)}…`)
  })

  it('does not truncate a string at or under 80 characters', () => {
    const exact = 'x'.repeat(80)
    expect(sessionLabel(session({ customTitle: exact }))).toBe(exact)
  })
})

describe('agentLabel', () => {
  it('uses stage when present', () => {
    expect(agentLabel(agent({ stage: 'impl-agent', agentType: 'port:impl-agent' }))).toBe('impl-agent')
  })

  it('falls back to agentType when stage is null', () => {
    expect(agentLabel(agent({ stage: null, agentType: 'Explore' }))).toBe('Explore')
  })

  it('appends #N when itemNumber is known', () => {
    expect(agentLabel(agent({ stage: 'review-agent', itemNumber: 42 }))).toBe('review-agent #42')
  })
})

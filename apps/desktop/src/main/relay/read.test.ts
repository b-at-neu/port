import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { AgentRecord, SessionRecord, SessionScan } from '../../shared/sessions/types'
import { createRelayReader } from './read'

const REPO_ID = 'repo-a' as RepoId
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'a1b2c3d4e5'

async function makeClaudeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-relay-read-'))
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

function assistantRecord(uuid: string, text: string): unknown {
  return { uuid, timestamp: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: text } }
}

function userRecord(uuid: string, text: string): unknown {
  return { uuid, timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: text } }
}

function agentOf(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    agentId: AGENT_ID,
    agentType: 'plan-agent',
    stage: 'plan-agent',
    model: 'opus',
    description: '#107 relay loop',
    itemNumber: 107,
    worktreePath: null,
    worktreeBranch: null,
    spawnDepth: 1,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    idleMs: 1000,
    activity: 'idle',
    ...overrides,
  }
}

function sessionOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    cwd: null,
    worktreePath: null,
    role: 'cockpit',
    roleEvidence: 'stage-agent',
    itemNumber: null,
    customTitle: 'cockpit session',
    summary: null,
    firstPrompt: null,
    gitBranch: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    idleMs: 1000,
    activity: 'idle',
    agentIds: [AGENT_ID],
    ...overrides,
  }
}

function scanOf(agents: readonly AgentRecord[], sessions: readonly SessionRecord[] = []): Extract<SessionScan, { ok: true }> {
  return { ok: true, sessions, agents, unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 0, scannedAt: '2026-01-01T00:00:00.000Z' }
}

async function writeAgentTranscript(claudeHome: string, records: readonly unknown[]): Promise<void> {
  const projectDir = join(claudeHome, 'projects', 'project-a')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), '')
  const subagentsDir = join(projectDir, SESSION_ID, 'subagents')
  await mkdir(subagentsDir, { recursive: true })
  await writeFile(join(subagentsDir, `agent-${AGENT_ID}.jsonl`), jsonl(records))
}

describe('createRelayReader — classification', () => {
  it('reports a pending question relay from the agent transcript tail', async () => {
    const claudeHome = await makeClaudeHome()
    await writeAgentTranscript(claudeHome, [
      userRecord('u1', 'go'),
      assistantRecord('u2', ['Need a decision.', '', 'QUESTIONS FOR HUMAN:', '1. Which branch is base?'].join('\n')),
    ])

    const reader = createRelayReader()
    const scan = await reader.read({ scan: scanOf([agentOf()], [sessionOf()]), claudeHome })

    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.pending).toHaveLength(1)
    expect(scan.pending[0]).toMatchObject({ kind: 'questions', number: 107, stage: 'plan-agent', sessionId: SESSION_ID, agentId: AGENT_ID })
    expect(scan.checked).toBe(1)
    expect(scan.unreached).toBe(0)
  })

  it('reports nothing waiting when the final message is an ordinary completion', async () => {
    const claudeHome = await makeClaudeHome()
    await writeAgentTranscript(claudeHome, [assistantRecord('u1', 'Opened PR #42 and pushed the branch.')])

    const reader = createRelayReader()
    const scan = await reader.read({ scan: scanOf([agentOf()], [sessionOf()]), claudeHome })

    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.pending).toEqual([])
    expect(scan.checked).toBe(1)
  })

  it('reports indeterminate, in unreached, for a transcript ending on a tool call rather than text', async () => {
    const claudeHome = await makeClaudeHome()
    await writeAgentTranscript(claudeHome, [
      { uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    ])

    const reader = createRelayReader()
    const scan = await reader.read({ scan: scanOf([agentOf()], [sessionOf()]), claudeHome })

    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.pending).toEqual([])
    expect(scan.unreached).toBe(1)
  })

  it('excludes an agent with no resolved stage from the candidate set entirely', async () => {
    const claudeHome = await makeClaudeHome()
    await writeAgentTranscript(claudeHome, [assistantRecord('u1', 'QUESTIONS FOR HUMAN:\n1. x?')])

    const reader = createRelayReader()
    const scan = await reader.read({ scan: scanOf([agentOf({ stage: null })], [sessionOf()]), claudeHome })

    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.pending).toEqual([])
    expect(scan.checked).toBe(0)
    expect(scan.unreached).toBe(0)
  })

  it('counts an unresolvable transcript path as checked and unreached, never silently dropped', async () => {
    const claudeHome = await makeClaudeHome()
    // `projects/` exists (so `buildProjectIndex` itself succeeds) but no
    // transcript is ever written for this agent's session, so
    // `resolveTranscriptPath` returns `ok: false` — the candidate must still
    // be counted rather than vanish before the counting loop runs.
    await mkdir(join(claudeHome, 'projects'), { recursive: true })

    const reader = createRelayReader()
    const scan = await reader.read({ scan: scanOf([agentOf()], [sessionOf()]), claudeHome })

    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.pending).toEqual([])
    expect(scan.checked).toBe(1)
    expect(scan.unreached).toBe(1)
  })

  it('propagates a not-ok session scan unchanged', async () => {
    const reader = createRelayReader()
    const scan = await reader.read({ scan: { ok: false, kind: 'claude-home-missing', message: 'no home', scannedAt: '2026-01-01T00:00:00.000Z' } })
    expect(scan.ok).toBe(false)
    if (scan.ok) throw new Error('unreachable')
    expect(scan.kind).toBe('claude-home-missing')
    expect(scan.message).toBe('no home')
  })
})

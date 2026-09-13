import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTranscript } from './transcript'

async function makeClaudeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-sessions-transcript-'))
}

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'a1b2c3d4e5'

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

describe('readTranscript', () => {
  it('reads a session transcript, deriving entries from its records', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    const records = [
      { uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo', type: 'user', message: { role: 'user', content: 'hello' } },
      {
        uuid: 'u2',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] },
      },
      {
        uuid: 'u3',
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false }] },
      },
    ]
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), jsonl(records))

    const result = await readTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source.sessionId).toBe(SESSION_ID)
    expect(result.source.agentId).toBeNull()
    expect(result.source.recordCount).toBe(3)
    expect(result.source.malformedLines).toBe(0)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({ type: 'user-text', text: { text: 'hello' } })
    expect(result.entries[1]).toMatchObject({ type: 'tool-call', name: 'Bash' })
  })

  it('reads a subagent transcript beneath subagents/', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), '')
    const subagentsDir = join(projectDir, SESSION_ID, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    const records = [{ uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: 'subagent prompt' } }]
    await writeFile(join(subagentsDir, `agent-${AGENT_ID}.jsonl`), jsonl(records))

    const result = await readTranscript({ sessionId: SESSION_ID, agentId: AGENT_ID, claudeHome })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source.agentId).toBe(AGENT_ID)
    expect(result.entries).toHaveLength(1)
  })

  it('reports invalid-id before touching the filesystem', async () => {
    const claudeHome = await makeClaudeHome()
    const result = await readTranscript({ sessionId: 'not-a-uuid', agentId: null, claudeHome })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('invalid-id')
    expect(result.path).toBeNull()
    expect(typeof result.message).toBe('string')
  })

  it('reports session-unresolved when no project directory carries the session', async () => {
    const claudeHome = await makeClaudeHome()
    const result = await readTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('session-unresolved')
  })

  it('reports not-found when the session resolves but the specific file is missing', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), '')
    // The session's own file exists (so the locate ladder resolves it), but
    // no subagent transcript was ever written for this agent id.

    const result = await readTranscript({ sessionId: SESSION_ID, agentId: AGENT_ID, claudeHome })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
    expect(result.path).toContain(`agent-${AGENT_ID}.jsonl`)
  })

  it('counts malformed lines without failing the whole read', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    const good1 = JSON.stringify({ uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: 'a' } })
    const good2 = JSON.stringify({ uuid: 'u2', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', message: { role: 'user', content: 'b' } })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), `${good1}\n{not valid json\n${good2}\n`)

    const result = await readTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source.malformedLines).toBe(1)
    expect(result.source.recordCount).toBe(2)
    expect(result.entries).toHaveLength(2)
  })

  it('aborts with too-large past the byte cap', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), 'x'.repeat(65 * 1024 * 1024))

    const result = await readTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('too-large')
  }, 20_000)
})

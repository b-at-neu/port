import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { advanceTranscript, openTranscript } from './transcript'
import type { TranscriptCursor } from './transcript'

async function makeClaudeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-sessions-transcript-'))
}

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'a1b2c3d4e5'

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

function record(uuid: string, timestamp: string, text: string): unknown {
  return { uuid, timestamp, type: 'user', message: { role: 'user', content: text } }
}

function requireCursor(cursor: TranscriptCursor | null): TranscriptCursor {
  if (cursor === null) throw new Error('unreachable: expected a cursor')
  return cursor
}

describe('openTranscript', () => {
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

    const { read, cursor } = await openTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source.sessionId).toBe(SESSION_ID)
    expect(read.source.agentId).toBeNull()
    expect(read.source.recordCount).toBe(3)
    expect(read.source.malformedLines).toBe(0)
    expect(read.entries).toHaveLength(2)
    expect(read.entries[0]).toMatchObject({ type: 'user-text', text: { text: 'hello' } })
    expect(read.entries[1]).toMatchObject({ type: 'tool-call', name: 'Bash' })
    expect(cursor).not.toBeNull()
    expect(requireCursor(cursor).nextIndex).toBe(2)
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

    const { read } = await openTranscript({ sessionId: SESSION_ID, agentId: AGENT_ID, claudeHome })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source.agentId).toBe(AGENT_ID)
    expect(read.entries).toHaveLength(1)
  })

  it('reports invalid-id before touching the filesystem', async () => {
    const claudeHome = await makeClaudeHome()
    const { read, cursor } = await openTranscript({ sessionId: 'not-a-uuid', agentId: null, claudeHome })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.kind).toBe('invalid-id')
    expect(read.path).toBeNull()
    expect(typeof read.message).toBe('string')
    expect(cursor).toBeNull()
  })

  it('reports session-unresolved when no project directory carries the session', async () => {
    const claudeHome = await makeClaudeHome()
    const { read } = await openTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.kind).toBe('session-unresolved')
  })

  it('reports not-found when the session resolves but the specific file is missing', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), '')
    // The session's own file exists (so the locate ladder resolves it), but
    // no subagent transcript was ever written for this agent id.

    const { read } = await openTranscript({ sessionId: SESSION_ID, agentId: AGENT_ID, claudeHome })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.kind).toBe('not-found')
    expect(read.path).toContain(`agent-${AGENT_ID}.jsonl`)
  })

  it('counts malformed lines without failing the whole read', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    const good1 = JSON.stringify({ uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: 'a' } })
    const good2 = JSON.stringify({ uuid: 'u2', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', message: { role: 'user', content: 'b' } })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), `${good1}\n{not valid json\n${good2}\n`)

    const { read } = await openTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source.malformedLines).toBe(1)
    expect(read.source.recordCount).toBe(2)
    expect(read.entries).toHaveLength(2)
  })

  it('aborts with too-large past the byte cap', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), 'x'.repeat(65 * 1024 * 1024))

    const { read } = await openTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.kind).toBe('too-large')
  }, 20_000)

  it('retries a stuck line past MAX_CHUNK_BYTES rather than failing the whole read', async () => {
    const claudeHome = await makeClaudeHome()
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    // A single record's JSONL line runs well past the 8 MB chunk window but
    // stays comfortably under the 64 MB transcript-level cap.
    const bigContent = 'x'.repeat(20 * 1024 * 1024)
    const records = [
      { uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo', type: 'user', message: { role: 'user', content: bigContent } },
      { uuid: 'u2', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', message: { role: 'user', content: 'after the big one' } },
    ]
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), jsonl(records))

    const { read } = await openTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source.recordCount).toBe(2)
    expect(read.source.malformedLines).toBe(0)
    expect(read.entries).toHaveLength(2)
    expect(read.entries[1]).toMatchObject({ type: 'user-text', text: { text: 'after the big one' } })
  }, 20_000)
})

describe('advanceTranscript', () => {
  async function openAt(claudeHome: string): Promise<{ path: string; cursor: TranscriptCursor }> {
    const projectDir = join(claudeHome, 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    const path = join(projectDir, `${SESSION_ID}.jsonl`)
    await writeFile(path, jsonl([record('u1', '2026-01-01T00:00:00.000Z', 'hello')]))
    const { cursor } = await openTranscript({ sessionId: SESSION_ID, agentId: null, claudeHome })
    return { path, cursor: requireCursor(cursor) }
  }

  it('reports nothing new when no bytes were appended', async () => {
    const claudeHome = await makeClaudeHome()
    const { cursor } = await openAt(claudeHome)

    const advanced = await advanceTranscript(cursor)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) throw new Error('unreachable')
    expect(advanced.appended).toHaveLength(0)
    expect(advanced.patched).toHaveLength(0)
    expect(advanced.hasMore).toBe(false)
    expect(advanced.cursor.offset).toBe(cursor.offset)
  })

  it('derives the newly appended record on the next advance', async () => {
    const claudeHome = await makeClaudeHome()
    const { path, cursor } = await openAt(claudeHome)

    await appendFile(path, jsonl([record('u2', '2026-01-01T00:00:01.000Z', 'world')]))
    const advanced = await advanceTranscript(cursor)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) throw new Error('unreachable')
    expect(advanced.appended).toHaveLength(1)
    expect(advanced.appended[0]).toMatchObject({ type: 'user-text', text: { text: 'world' } })
    expect(advanced.source.recordCount).toBe(2)
    expect(advanced.cursor.nextIndex).toBe(2)
  })

  it('leaves a partial trailing line for the next advance, yielding exactly one entry once it completes', async () => {
    const claudeHome = await makeClaudeHome()
    const { path, cursor } = await openAt(claudeHome)

    const wholeLine = JSON.stringify(record('u2', '2026-01-01T00:00:01.000Z', 'partial'))
    await appendFile(path, wholeLine) // no trailing newline yet
    const firstAdvance = await advanceTranscript(cursor)
    expect(firstAdvance.ok).toBe(true)
    if (!firstAdvance.ok) throw new Error('unreachable')
    expect(firstAdvance.appended).toHaveLength(0)

    await appendFile(path, '\n')
    const secondAdvance = await advanceTranscript(firstAdvance.cursor)
    expect(secondAdvance.ok).toBe(true)
    if (!secondAdvance.ok) throw new Error('unreachable')
    expect(secondAdvance.appended).toHaveLength(1)
    expect(secondAdvance.appended[0]).toMatchObject({ type: 'user-text', text: { text: 'partial' } })
  })

  it('reports truncated when the file on disk is now smaller than the cursor offset', async () => {
    const claudeHome = await makeClaudeHome()
    const { path, cursor } = await openAt(claudeHome)

    await writeFile(path, '')
    const advanced = await advanceTranscript(cursor)
    expect(advanced.ok).toBe(false)
    if (advanced.ok) throw new Error('unreachable')
    expect(advanced.kind).toBe('truncated')
    expect(advanced.path).toBe(path)
  })

  it('pairs a tool_use in one chunk with a tool_result appended after it', async () => {
    const claudeHome = await makeClaudeHome()
    const { path, cursor } = await openAt(claudeHome)

    await appendFile(
      path,
      jsonl([
        {
          uuid: 'u2',
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] },
        },
      ]),
    )
    const afterUse = await advanceTranscript(cursor)
    expect(afterUse.ok).toBe(true)
    if (!afterUse.ok) throw new Error('unreachable')
    expect(afterUse.appended[0]).toMatchObject({ type: 'tool-call', result: null })

    await appendFile(
      path,
      jsonl([
        {
          uuid: 'u3',
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false }] },
        },
      ]),
    )
    const afterResult = await advanceTranscript(afterUse.cursor)
    expect(afterResult.ok).toBe(true)
    if (!afterResult.ok) throw new Error('unreachable')
    expect(afterResult.appended).toHaveLength(0)
    expect(afterResult.patched).toHaveLength(1)
    expect(afterResult.patched[0]).toMatchObject({ index: 1, entry: { type: 'tool-call', result: { isError: false } } })
  })

  it('retries a poll stuck on a line past MAX_CHUNK_BYTES rather than failing it', async () => {
    const claudeHome = await makeClaudeHome()
    const { path, cursor } = await openAt(claudeHome)

    // The deriver caps rendered payload text at MAX_PAYLOAD_CHARS regardless
    // of the underlying record's size, so assert on a leading marker rather
    // than the whole (deliberately oversized) content.
    const bigContent = 'START-MARKER-' + 'x'.repeat(20 * 1024 * 1024)
    await appendFile(path, jsonl([record('u2', '2026-01-01T00:00:01.000Z', bigContent)]))
    const advanced = await advanceTranscript(cursor)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) throw new Error('unreachable')
    expect(advanced.appended).toHaveLength(1)
    const entry = advanced.appended[0]
    if (entry === undefined) throw new Error('unreachable')
    expect(entry.type).toBe('user-text')
    expect((entry as { text: { text: string } }).text.text.startsWith('START-MARKER-')).toBe(true)
  }, 20_000)
})

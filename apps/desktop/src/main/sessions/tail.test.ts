import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTailStore } from './tail'
import { advanceTranscript, openTranscript } from './transcript'

async function makeClaudeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-sessions-tail-'))
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

function record(uuid: string, text: string): unknown {
  return { uuid, timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: text } }
}

async function makeSession(claudeHome: string, sessionId: string, records: readonly unknown[] = []): Promise<string> {
  const projectDir = join(claudeHome, 'projects', 'project-a')
  await mkdir(projectDir, { recursive: true })
  const path = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(path, jsonl(records))
  return path
}

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `11111111-2222-3333-4444-${sessionCounter.toString().padStart(12, '0')}`
}

describe('tail store', () => {
  it('opens, then reports a newly appended record on poll', async () => {
    const claudeHome = await makeClaudeHome()
    const sessionId = nextSessionId()
    const path = await makeSession(claudeHome, sessionId, [record('u1', 'hello')])
    const store = createTailStore()

    const opened = await store.openTail({ sessionId, agentId: null, claudeHome })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('unreachable')
    expect(opened.entries).toHaveLength(1)

    await appendFile(path, jsonl([record('u2', 'world')]))
    const polled = await store.pollTail({ tailId: opened.tailId })
    expect(polled.ok).toBe(true)
    if (!polled.ok) throw new Error('unreachable')
    expect(polled.appended).toHaveLength(1)
    expect(polled.appended[0]).toMatchObject({ type: 'user-text', text: { text: 'world' } })
  })

  it('reports unknown-tail for an id that was never opened', async () => {
    const store = createTailStore()
    const polled = await store.pollTail({ tailId: 'tail-999' })
    expect(polled.ok).toBe(false)
    if (polled.ok) throw new Error('unreachable')
    expect(polled.kind).toBe('unknown-tail')
    expect(typeof polled.message).toBe('string')
    expect(polled.path).toBeNull()
  })

  it('reports truncated when the file shrinks below the cursor offset, and drops the tail', async () => {
    const claudeHome = await makeClaudeHome()
    const sessionId = nextSessionId()
    const path = await makeSession(claudeHome, sessionId, [record('u1', 'hello')])
    const store = createTailStore()

    const opened = await store.openTail({ sessionId, agentId: null, claudeHome })
    if (!opened.ok) throw new Error('unreachable')

    await writeFile(path, '')
    const polled = await store.pollTail({ tailId: opened.tailId })
    expect(polled.ok).toBe(false)
    if (polled.ok) throw new Error('unreachable')
    expect(polled.kind).toBe('truncated')

    // The stale cursor is dropped rather than kept re-reporting truncated —
    // a later poll against the same id is a fresh unknown-tail.
    const again = await store.pollTail({ tailId: opened.tailId })
    expect(again).toMatchObject({ ok: false, kind: 'unknown-tail' })
  })

  it('closes a tail, after which polling it reports unknown-tail', async () => {
    const claudeHome = await makeClaudeHome()
    const sessionId = nextSessionId()
    await makeSession(claudeHome, sessionId, [record('u1', 'hello')])
    const store = createTailStore()

    const opened = await store.openTail({ sessionId, agentId: null, claudeHome })
    if (!opened.ok) throw new Error('unreachable')
    store.closeTail({ tailId: opened.tailId })

    const polled = await store.pollTail({ tailId: opened.tailId })
    expect(polled).toMatchObject({ ok: false, kind: 'unknown-tail' })
  })

  it('evicts the least-recently-touched tail once the open cap is reached', async () => {
    const claudeHome = await makeClaudeHome()
    let clock = 0
    const store = createTailStore({ openTranscript, advanceTranscript, now: () => clock })

    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const sessionId = nextSessionId()
      await makeSession(claudeHome, sessionId, [record('u1', 'hello')])
      clock += 1
      const opened = await store.openTail({ sessionId, agentId: null, claudeHome })
      if (!opened.ok) throw new Error('unreachable')
      ids.push(opened.tailId)
    }
    expect(store.size).toBe(8)

    // A 9th open must evict the oldest (ids[0]) rather than growing past the cap.
    const sessionId = nextSessionId()
    await makeSession(claudeHome, sessionId, [record('u1', 'hello')])
    clock += 1
    const opened = await store.openTail({ sessionId, agentId: null, claudeHome })
    if (!opened.ok) throw new Error('unreachable')

    expect(store.size).toBe(8)
    const evicted = await store.pollTail({ tailId: ids[0] as string })
    expect(evicted).toMatchObject({ ok: false, kind: 'unknown-tail' })
  })
})

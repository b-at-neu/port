import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { SessionRecord, SessionScan } from '../../shared/sessions/types'
import { SCAN_BUDGET_MS } from '../../shared/search/types'
import type { SearchScope } from '../../shared/search/types'
import { runSearch } from './query'

const REPO_A = 'repo-a' as RepoId
const REPO_B = 'repo-b' as RepoId

const SESSION_A = '11111111-1111-1111-1111-111111111111'
const SESSION_B = '22222222-2222-2222-2222-222222222222'

async function makeClaudeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-search-query-claude-home-'))
}

async function makeIndexDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-search-query-index-'))
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

async function writeSessionTranscript(claudeHome: string, project: string, sessionId: string, text: string): Promise<void> {
  const dir = join(claudeHome, 'projects', project)
  await mkdir(dir, { recursive: true })
  const record = { uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo', type: 'user', message: { role: 'user', content: text } }
  await writeFile(join(dir, `${sessionId}.jsonl`), jsonl([record]))
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_A,
    repoId: REPO_A,
    cwd: '/repo',
    worktreePath: null,
    role: 'other',
    roleEvidence: null,
    itemNumber: null,
    customTitle: 'a session',
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

function scanOf(sessions: readonly SessionRecord[]): Extract<SessionScan, { ok: true }> {
  return { ok: true, sessions, agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 0, scannedAt: new Date(0).toISOString() }
}

const REPO_SCOPE: SearchScope = { kind: 'repo', repoId: REPO_A }
const ALL_SCOPE: SearchScope = { kind: 'all' }

describe('runSearch', () => {
  it('returns invalid-query for a query under MIN_TERM_CHARS', async () => {
    const result = await runSearch({ scan: scanOf([]), indexDir: await makeIndexDir(), query: 'ab', scope: ALL_SCOPE, claudeHome: await makeClaudeHome() })
    expect(result).toEqual({ ok: false, kind: 'invalid-query' })
  })

  it('passes through a failed scan as sessions-unavailable', async () => {
    const scan: SessionScan = { ok: false, kind: 'sdk-unavailable', message: 'no sdk', scannedAt: new Date(0).toISOString() }
    const result = await runSearch({ scan, indexDir: await makeIndexDir(), query: 'needle', scope: ALL_SCOPE, claudeHome: await makeClaudeHome() })
    expect(result).toEqual({ ok: false, kind: 'sessions-unavailable', sessionsKind: 'sdk-unavailable', message: 'no sdk' })
  })

  it('finds a hit in a session transcript within its repo scope', async () => {
    const claudeHome = await makeClaudeHome()
    await writeSessionTranscript(claudeHome, 'project-a', SESSION_A, 'the answer contains needle-term right here')
    const scan = scanOf([session()])

    const result = await runSearch({ scan, indexDir: await makeIndexDir(), query: 'needle-term', scope: REPO_SCOPE, claudeHome })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.inScope).toBe(1)
    expect(result.read).toBe(1)
    expect(result.skippedByIndex).toBe(0)
    expect(result.complete).toBe(true)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.hits[0]?.snippet.text).toContain('needle-term')
  })

  it('excludes an out-of-scope repo under repo scope, includes it under all', async () => {
    const claudeHome = await makeClaudeHome()
    await writeSessionTranscript(claudeHome, 'project-b', SESSION_B, 'a needle-term over here too')
    const scan = scanOf([session({ sessionId: SESSION_B, repoId: REPO_B })])

    const scoped = await runSearch({ scan, indexDir: await makeIndexDir(), query: 'needle-term', scope: REPO_SCOPE, claudeHome })
    expect(scoped.ok).toBe(true)
    if (!scoped.ok) throw new Error('unreachable')
    expect(scoped.inScope).toBe(0)
    expect(scoped.groups).toHaveLength(0)

    const all = await runSearch({ scan, indexDir: await makeIndexDir(), query: 'needle-term', scope: ALL_SCOPE, claudeHome })
    expect(all.ok).toBe(true)
    if (!all.ok) throw new Error('unreachable')
    expect(all.inScope).toBe(1)
    expect(all.groups).toHaveLength(1)
  })

  it('reads again on a repeated search for a term that is actually present -- a Bloom signature only ever proves absence, never presence', async () => {
    const claudeHome = await makeClaudeHome()
    await writeSessionTranscript(claudeHome, 'project-a', SESSION_A, 'the answer contains needle-term right here')
    const scan = scanOf([session()])
    const indexDir = await makeIndexDir()

    const first = await runSearch({ scan, indexDir, query: 'needle-term', scope: REPO_SCOPE, claudeHome })
    expect(first.ok && first.read).toBe(1)

    const second = await runSearch({ scan, indexDir, query: 'needle-term', scope: REPO_SCOPE, claudeHome })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.read).toBe(1)
    expect(second.skippedByIndex).toBe(0)
    expect(second.groups).toHaveLength(1)
  })

  it('proves absence of a term never seen in the transcript on the warmed index, and returns no groups without reading again', async () => {
    const claudeHome = await makeClaudeHome()
    await writeSessionTranscript(claudeHome, 'project-a', SESSION_A, 'the answer contains needle-term right here')
    const scan = scanOf([session()])
    const indexDir = await makeIndexDir()

    await runSearch({ scan, indexDir, query: 'needle-term', scope: REPO_SCOPE, claudeHome })
    const second = await runSearch({ scan, indexDir, query: 'zzzqqqxxx', scope: REPO_SCOPE, claudeHome })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.read).toBe(0)
    expect(second.skippedByIndex).toBe(1)
    expect(second.groups).toHaveLength(0)
  })

  it('reports unreached, never an empty result read as "nothing matched", once the scan budget is exhausted', async () => {
    const claudeHome = await makeClaudeHome()
    await writeSessionTranscript(claudeHome, 'project-a', SESSION_A, 'needle-term one')
    await writeSessionTranscript(claudeHome, 'project-b', SESSION_B, 'needle-term two')
    const scan = scanOf([session(), session({ sessionId: SESSION_B, repoId: REPO_A, idleMs: 1 })])

    let calls = 0
    const now = (): Date => {
      calls += 1
      return new Date(calls <= 2 ? 0 : SCAN_BUDGET_MS)
    }

    const result = await runSearch({ scan, indexDir: await makeIndexDir(), query: 'needle-term', scope: REPO_SCOPE, claudeHome, now })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.read).toBe(1)
    expect(result.unreached).toBe(1)
    expect(result.complete).toBe(false)
  })
})

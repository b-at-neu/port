import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathOps } from '../platform'
import type { RepoRef } from './classify'
import { readSessionState } from './adapter'
import type { RawSession } from './sdk'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

// The locate ladder only recognizes a real UUID-shaped `<id>.jsonl` — these
// stand in for readable fixture names below.
const SESSION_COCKPIT = '11111111-0000-0000-0000-000000000001'
const SESSION_PLAIN = '11111111-0000-0000-0000-000000000002'
const SESSION_UNATTRIBUTED = '11111111-0000-0000-0000-000000000003'
const SESSION_GHOST = '11111111-0000-0000-0000-000000000004'
const SESSION_WITH_AGENTS = '11111111-0000-0000-0000-000000000005'

function rawSession(overrides: Partial<RawSession> & { sessionId: string }): RawSession {
  return {
    summary: null,
    lastModified: new Date().toISOString(),
    customTitle: null,
    firstPrompt: null,
    gitBranch: null,
    cwd: null,
    ...overrides,
  }
}

/** Lays out `<claudeHome>/projects/<projectName>/<sessionId>.jsonl` (and,
 *  when `agents` is given, a `subagents/` directory beside it) — the fixture
 *  shape `locate.test.ts` also builds. */
async function makeSession(
  claudeHome: string,
  projectName: string,
  sessionId: string,
  agents: readonly { readonly agentId: string; readonly meta: 'malformed' | Record<string, unknown> }[] = [],
): Promise<void> {
  const projectDir = join(claudeHome, 'projects', projectName)
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${sessionId}.jsonl`), '')
  if (agents.length === 0) return
  const subagentsDir = join(projectDir, sessionId, 'subagents')
  await mkdir(subagentsDir, { recursive: true })
  for (const agent of agents) {
    await writeFile(join(subagentsDir, `agent-${agent.agentId}.jsonl`), '')
    const body = agent.meta === 'malformed' ? '{not json' : JSON.stringify(agent.meta)
    await writeFile(join(subagentsDir, `agent-${agent.agentId}.meta.json`), body)
  }
}

describe('readSessionState', () => {
  it('a full scan across two repositories attributes a cockpit and two stage agents', async () => {
    const claudeHome = await makeTempDir('port-sessions-adapter-')
    const repoARoot = await makeTempDir('port-sessions-repo-a-')
    const repoBRoot = await makeTempDir('port-sessions-repo-b-')

    await makeSession(claudeHome, 'project-a', SESSION_COCKPIT, [
      { agentId: 'a1', meta: { agentType: 'port:plan-agent', description: 'plan #10', model: 'opus' } },
      { agentId: 'a2', meta: { agentType: 'port:impl-agent', description: 'impl #11', model: 'sonnet' } },
    ])
    await makeSession(claudeHome, 'project-b', SESSION_PLAIN)

    const repos: readonly RepoRef[] = [
      { id: pathOps.pathKey(repoARoot) as unknown as RepoRef['id'], root: repoARoot },
      { id: pathOps.pathKey(repoBRoot) as unknown as RepoRef['id'], root: repoBRoot },
    ]

    const result = await readSessionState({
      repos,
      claudeHome,
      reader: () =>
        Promise.resolve({
          ok: true,
          sessions: [
            rawSession({ sessionId: SESSION_COCKPIT, cwd: repoARoot, firstPrompt: '/port:pipeline' }),
            rawSession({ sessionId: SESSION_PLAIN, cwd: repoBRoot }),
          ],
        }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.sessions).toHaveLength(2)
    const cockpit = result.sessions.find((s) => s.sessionId === SESSION_COCKPIT)
    expect(cockpit?.role).toBe('cockpit')
    expect(cockpit?.roleEvidence).toBe('stage-agent')
    expect(cockpit?.repoId).toBe(repos[0]?.id)
    expect(result.agents).toHaveLength(2)
    expect(result.agents.map((a) => a.stage).sort()).toEqual(['impl-agent', 'plan-agent'])
    expect(result.agents.every((a) => a.itemNumber !== null)).toBe(true)
    expect(result.unattributed).toBe(0)
  })

  it('an unattributed session is counted but carries no repoId', async () => {
    const claudeHome = await makeTempDir('port-sessions-adapter-')
    const repoRoot = await makeTempDir('port-sessions-repo-')
    const unregisteredCwd = await makeTempDir('port-sessions-unregistered-')

    await makeSession(claudeHome, 'project-x', SESSION_UNATTRIBUTED)

    const repos: readonly RepoRef[] = [{ id: pathOps.pathKey(repoRoot) as unknown as RepoRef['id'], root: repoRoot }]
    const result = await readSessionState({
      repos,
      claudeHome,
      reader: () => Promise.resolve({ ok: true, sessions: [rawSession({ sessionId: SESSION_UNATTRIBUTED, cwd: unregisteredCwd })] }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.unattributed).toBe(1)
    expect(result.sessions[0]?.repoId).toBeNull()
    expect(result.agents).toEqual([])
  })

  it('a session whose directory cannot be resolved appears in unresolved, never with an agents: [] claim', async () => {
    const claudeHome = await makeTempDir('port-sessions-adapter-')
    const repoRoot = await makeTempDir('port-sessions-repo-')
    // A populated projects/ tree that simply never mentions this session id
    // — the index builds fine, but the ladder still finds nothing for it.
    await makeSession(claudeHome, 'project-other', SESSION_UNATTRIBUTED)
    const result = await readSessionState({
      repos: [{ id: pathOps.pathKey(repoRoot) as unknown as RepoRef['id'], root: repoRoot }],
      claudeHome,
      reader: () => Promise.resolve({ ok: true, sessions: [rawSession({ sessionId: SESSION_GHOST, cwd: repoRoot })] }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.unresolved).toEqual([{ sessionId: SESSION_GHOST }])
    expect(result.sessions.find((s) => s.sessionId === SESSION_GHOST)).toBeUndefined()
  })

  it('a malformed meta.json lands in unreadable, with its siblings intact', async () => {
    const claudeHome = await makeTempDir('port-sessions-adapter-')
    const repoRoot = await makeTempDir('port-sessions-repo-')

    await makeSession(claudeHome, 'project-a', SESSION_WITH_AGENTS, [
      { agentId: 'good', meta: { agentType: 'port:review-agent', description: 'review #5' } },
      { agentId: 'bad', meta: 'malformed' },
    ])

    const result = await readSessionState({
      repos: [{ id: pathOps.pathKey(repoRoot) as unknown as RepoRef['id'], root: repoRoot }],
      claudeHome,
      reader: () => Promise.resolve({ ok: true, sessions: [rawSession({ sessionId: SESSION_WITH_AGENTS, cwd: repoRoot })] }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]?.agentId).toBe('good')
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]?.agentId).toBe('bad')
    expect(result.unreadable[0]?.kind).toBe('unparseable')
  })

  it('each ok: false kind carries no sessions field at all', async () => {
    const claudeHome = await makeTempDir('port-sessions-adapter-')

    const sdkUnavailable = await readSessionState({
      repos: [],
      claudeHome,
      reader: () => Promise.resolve({ ok: false, kind: 'sdk-unavailable', message: 'no sdk' }),
    })
    expect(sdkUnavailable.ok).toBe(false)
    if (sdkUnavailable.ok) throw new Error('unreachable')
    expect(sdkUnavailable.kind).toBe('sdk-unavailable')
    expect(sdkUnavailable.message).toBe('no sdk')
    expect(typeof sdkUnavailable.scannedAt).toBe('string')
    expect('sessions' in sdkUnavailable).toBe(false)

    const sdkFailed = await readSessionState({
      repos: [],
      claudeHome,
      reader: () => Promise.resolve({ ok: false, kind: 'sdk-failed', message: 'boom' }),
    })
    expect('sessions' in sdkFailed).toBe(false)

    const claudeHomeMissing = await readSessionState({
      repos: [],
      claudeHome: join(claudeHome, 'does-not-exist'),
      reader: () => Promise.resolve({ ok: true, sessions: [] }),
    })
    expect(claudeHomeMissing.ok).toBe(false)
    if (claudeHomeMissing.ok) throw new Error('unreachable')
    expect(claudeHomeMissing.kind).toBe('claude-home-missing')
    expect(typeof claudeHomeMissing.message).toBe('string')
    expect('sessions' in claudeHomeMissing).toBe(false)
  })

  it('no failure path produces ok: true with an empty sessions array', async () => {
    const claudeHome = await makeTempDir('port-sessions-adapter-')
    const results = await Promise.all([
      readSessionState({ repos: [], claudeHome, reader: () => Promise.resolve({ ok: false, kind: 'sdk-unavailable', message: 'x' }) }),
      readSessionState({ repos: [], claudeHome, reader: () => Promise.resolve({ ok: false, kind: 'sdk-failed', message: 'x' }) }),
      readSessionState({ repos: [], claudeHome: join(claudeHome, 'missing'), reader: () => Promise.resolve({ ok: true, sessions: [] }) }),
    ])
    for (const result of results) {
      if (result.ok) {
        expect(result.sessions.length === 0 && result.ok).not.toBe(true)
      }
    }
    expect(results.every((r) => !r.ok)).toBe(true)
  })
})

// Gated exactly as gh.test.ts gates on ghAuthStatus() — this machine's real
// <claudeHome>/projects is the fixture, so CI (which has none) skips it and
// the unit suites above stay the acceptance evidence everywhere else.
const REAL_CLAUDE_HOME = join(homedir(), '.claude')
const hasRealProjects = await pathExists(join(REAL_CLAUDE_HOME, 'projects'))

/** A dispatched agent's own worktree carries no session history of its own
 *  yet — the real history sits on the checkout it was cut from. Registering
 *  both roots is what makes this case pass from an agent's own worktree as
 *  well as from an operator's ordinary checkout. */
function candidateRepoRoots(): readonly string[] {
  const worktreeRoot = resolve(process.cwd(), '..')
  const marker = `${sep}.claude${sep}worktrees${sep}`
  const markerIndex = worktreeRoot.indexOf(marker)
  if (markerIndex === -1) return [worktreeRoot]
  return [worktreeRoot, worktreeRoot.slice(0, markerIndex)]
}

describe.skipIf(!hasRealProjects)('readSessionState — live', () => {
  it(
    'attributes at least one real session to this checkout, with every stage-bearing agent carrying an itemNumber',
    async () => {
      const repos: readonly RepoRef[] = candidateRepoRoots().map((root) => ({
        id: pathOps.pathKey(root) as unknown as RepoRef['id'],
        root,
      }))
      const result = await readSessionState({ repos })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.scannedProjects).toBeGreaterThan(0)
      expect(result.sessions.some((s) => s.repoId !== null)).toBe(true)
      expect(result.agents.filter((a) => a.stage !== null).every((a) => a.itemNumber !== null)).toBe(true)
      // #78: the measured cost is recorded in the pull request's ## Notes,
      // per the plan's testing step — printed rather than asserted, since
      // there is no "correct" value to check it against.
      console.log(`readSessionState live case: scanMs=${String(result.scanMs)} scannedProjects=${String(result.scannedProjects)}`)
    },
    30_000,
  )
})

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInProcessEngine } from '@/main/offload/engine'
import { fakeGit } from '../../../fixtures/watcher-harness'

const now = () => new Date('2026-01-01T00:00:00.000Z')
const session = { sessionId: 's1', summary: null, lastModified: '2026-01-01T00:00:00.000Z', customTitle: 'hello', firstPrompt: null, gitBranch: null, cwd: null }

async function makeClaudeHome(): Promise<string> {
  const claudeHome = await mkdtemp(join(tmpdir(), 'port-offload-engine-'))
  await mkdir(join(claudeHome, 'projects'), { recursive: true })
  return claudeHome
}

describe('createInProcessEngine', () => {
  it('projects the cache it refreshed, and reports sessions as unscanned before that', async () => {
    const engine = createInProcessEngine({ now, git: fakeGit({ worktreeList: 0 }), claudeHome: await makeClaudeHome(), sessionReader: () => Promise.resolve({ ok: true, sessions: [] }) })
    const before = await engine.project({ repositories: [] })
    expect(before.sessions.ok).toBe(false)
    expect(await engine.refreshSessions({ repos: [] })).toMatchObject({ ok: true })
    const after = await engine.project({ repositories: [] })
    expect(after.sessions.ok).toBe(true)
  })

  it('lists sessions through the injected reader', async () => {
    const engine = createInProcessEngine({ sessionReader: () => Promise.resolve({ ok: true, sessions: [session] }) })
    expect(await engine.listSessions()).toEqual({ ok: true, sessions: [session] })
  })

  it('a tail opened on one call is closable on the next, since the engine owns the store', async () => {
    const engine = createInProcessEngine({ sessionReader: () => Promise.resolve({ ok: true, sessions: [] }) })
    expect(await engine.tailPoll({ tailId: 'tail-1' })).toMatchObject({ ok: false, kind: 'unknown-tail' })
    await expect(engine.tailClose({ tailId: 'tail-1' })).resolves.toBeUndefined()
  })
})

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProjectIndex, resolveSessionDir } from './locate'

async function makeClaudeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-sessions-locate-'))
}

async function makeProjectDir(claudeHome: string, name: string, sessionIds: readonly string[]): Promise<string> {
  const dir = join(claudeHome, 'projects', name)
  await mkdir(dir, { recursive: true })
  for (const id of sessionIds) {
    await writeFile(join(dir, `${id}.jsonl`), '')
  }
  return dir
}

const SESSION_A = '11111111-1111-1111-1111-111111111111'
const SESSION_B = '22222222-2222-2222-2222-222222222222'

describe('buildProjectIndex', () => {
  it('resolves a session under a project directory whose name is not derivable from any mangling of its cwd', async () => {
    // The load-bearing case: a real worktree's project directory carries a
    // hash suffix (`-home-...-issue-396-1d2d9e`) that no dashed rewrite of
    // the cwd produces. A mangling-based implementation fails exactly here.
    const claudeHome = await makeClaudeHome()
    const projectDir = await makeProjectDir(claudeHome, '-home-user-project--claude-worktrees-issue-42-a1b2c3', [SESSION_A])

    const result = await buildProjectIndex(claudeHome)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(resolveSessionDir(SESSION_A, result.index)).toBe(join(projectDir, SESSION_A))
  })

  it('resolves two project directories, one session each, both resolved', async () => {
    const claudeHome = await makeClaudeHome()
    const dirA = await makeProjectDir(claudeHome, 'project-a', [SESSION_A])
    const dirB = await makeProjectDir(claudeHome, 'project-b', [SESSION_B])

    const result = await buildProjectIndex(claudeHome)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(resolveSessionDir(SESSION_A, result.index)).toBe(join(dirA, SESSION_A))
    expect(resolveSessionDir(SESSION_B, result.index)).toBe(join(dirB, SESSION_B))
    expect(result.scannedProjects).toBe(2)
  })

  it('an unlisted session id resolves to undefined', async () => {
    const claudeHome = await makeClaudeHome()
    await makeProjectDir(claudeHome, 'project-a', [SESSION_A])

    const result = await buildProjectIndex(claudeHome)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(resolveSessionDir(SESSION_B, result.index)).toBeUndefined()
  })

  it('a projects/ directory that does not exist yields claude-home-missing', async () => {
    const claudeHome = await makeClaudeHome()
    const result = await buildProjectIndex(join(claudeHome, 'nonexistent'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('claude-home-missing')
    expect(result.message).toContain('does not exist')
  })
})

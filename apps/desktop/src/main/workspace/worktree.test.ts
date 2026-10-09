// Real `git init` repos in `mkdtemp` — no fake `GitRunner`, since the collision-retry and
// exclude-append paths depend on real git exit codes and file layout.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultGitRunner } from '../platform/git'
import { createSessionWorktree, removeSessionWorktree } from './worktree'

const git = defaultGitRunner()

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'port-workspace-worktree-'))
  await git(['init'], root)
  await git(['config', 'user.name', 'Port Test'], root)
  await git(['config', 'user.email', 'test@example.invalid'], root)
  await writeFile(join(root, 'README.md'), 'hello\n')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  return root
}

let gitAvailable = true

describe('worktree — real git integration', () => {
  beforeEach(async () => {
    const probe = await git(['--version'], tmpdir())
    gitAvailable = probe.ok
  })

  it('creates a worktree at `.claude/worktrees/session-<hex>` on a new branch from HEAD', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const result = await createSessionWorktree({ root, git })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.path).toBe(join(root, '.claude', 'worktrees', `session-${result.branch.replace('session/', '')}`))
    expect(result.branch.startsWith('session/')).toBe(true)

    const listed = await git(['worktree', 'list', '--porcelain'], root)
    expect(listed.ok).toBe(true)
    // Suffix match: a short-name/long-name path alias (e.g. Windows' `RUNNER~1`) survives separator normalization.
    if (listed.ok) expect(listed.stdout).toContain(`.claude/worktrees/session-${result.branch.replace('session/', '')}`)
  })

  it('appends the exclude line to <git-common-dir>/info/exclude, idempotently', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const first = await createSessionWorktree({ root, git })
    expect(first.ok).toBe(true)

    const excludePath = join(root, '.git', 'info', 'exclude')
    const afterFirst = await readFile(excludePath, 'utf8')
    expect(afterFirst).toContain('/.claude/worktrees/')

    const second = await createSessionWorktree({ root, git, random: () => 'bbbbbbbb' })
    expect(second.ok).toBe(true)
    const afterSecond = await readFile(excludePath, 'utf8')
    expect(afterSecond.match(/\/\.claude\/worktrees\//g)?.length).toBe(1)
  })

  it('records branch.<branch>.portBase at the created sha', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const result = await createSessionWorktree({ root, git })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const configured = await git(['config', `branch.${result.branch}.portBase`], root)
    expect(configured.ok).toBe(true)
    if (configured.ok) expect(configured.stdout.trim()).toBe(result.baseSha)
  })

  it('retries once with fresh hex on a branch-name collision, then succeeds', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    // Pre-create the branch the first hex would collide on.
    await git(['branch', 'session/aaaaaa'], root)

    let calls = 0
    const random = () => {
      calls += 1
      return calls === 1 ? 'aaaaaa' : 'cccccc'
    }
    const result = await createSessionWorktree({ root, git, random })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.branch).toBe('session/cccccc')
  })

  it('fails after a second collision rather than retrying forever', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    await git(['branch', 'session/aaaaaa'], root)
    const result = await createSessionWorktree({ root, git, random: () => 'aaaaaa' })
    expect(result.ok).toBe(false)
  })

  it('removes a clean worktree and keeps its branch', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const created = await createSessionWorktree({ root, git })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const removed = await removeSessionWorktree({ root, path: created.path, force: false, git })
    expect(removed).toEqual({ outcome: 'removed' })

    const branches = await git(['branch', '--list', created.branch], root)
    expect(branches.ok).toBe(true)
    if (branches.ok) expect(branches.stdout).toContain(created.branch.replace('session/', ''))
  })

  it('refuses to remove a dirty worktree without force, reporting `dirty`', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const created = await createSessionWorktree({ root, git })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await writeFile(join(created.path, 'untracked.txt'), 'dirty\n')

    const removed = await removeSessionWorktree({ root, path: created.path, force: false, git })
    expect(removed).toEqual({ outcome: 'dirty' })
  })

  it('force-removes a dirty worktree, still keeping its branch', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const created = await createSessionWorktree({ root, git })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await writeFile(join(created.path, 'untracked.txt'), 'dirty\n')

    const removed = await removeSessionWorktree({ root, path: created.path, force: true, git })
    expect(removed).toEqual({ outcome: 'removed' })

    const branches = await git(['branch', '--list', created.branch], root)
    expect(branches.ok).toBe(true)
    if (branches.ok) expect(branches.stdout).toContain(created.branch.replace('session/', ''))
  })

  it('reports `failed` for a path that was never a worktree', async (ctx) => {
    if (!gitAvailable) {
      ctx.skip()
      return
    }
    const root = await makeRepo()
    const removed = await removeSessionWorktree({ root, path: join(root, 'nonexistent'), force: false, git })
    expect(removed.outcome).toBe('failed')
  })
})

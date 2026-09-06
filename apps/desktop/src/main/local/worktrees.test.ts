import { describe, expect, it } from 'vitest'
import { createPathOps, pathOps as hostPathOps } from '../platform'
import type { CommandResult } from '../platform'
import { readWorktrees } from './worktrees'
import type { GitRunner } from './worktrees'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(code: number, stderr = ''): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: ['/usr/bin/git'] }
const now = () => new Date('2026-01-01T00:00:00.000Z')

interface Router {
  readonly list?: CommandResult
  readonly config?: CommandResult
  readonly log?: CommandResult
}

/** Routes by the git subcommand (`args[0]`), recording every call made so a
 *  test can assert the exact call budget. `config`/`log` default to the
 *  common "nothing to report" shape so a test that only cares about
 *  `worktree list` need not stub every call. */
function routedGit(router: Router, calls: string[][]): GitRunner {
  return (args) => {
    calls.push([...args])
    if (args[0] === 'worktree') return Promise.resolve(router.list ?? ok(''))
    if (args[0] === 'config') return Promise.resolve(router.config ?? nonzero(1))
    if (args[0] === 'log') return Promise.resolve(router.log ?? ok(''))
    return Promise.reject(new Error(`unexpected call: ${args.join(' ')}`))
  }
}

function stanza(lines: readonly string[]): string {
  return lines.join('\n')
}

describe('readWorktrees — field mapping', () => {
  it('parses the main worktree and a branch-carrying linked worktree', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza([
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo-worktrees/impl-77',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/77-foo',
        '',
      ]),
    )
    const result = await readWorktrees({
      repoRoot: '/repo',
      git: routedGit({ list }, calls),
      now,
      pathOps: createPathOps('posix', { home: '/home/u' }),
    })
    if (!result.ok) throw new Error('expected ok')
    expect(result.mainPath).toBe('/repo')
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({ path: '/repo', isMain: true, branch: 'main' })
    expect(result.entries[1]).toMatchObject({
      path: '/repo-worktrees/impl-77',
      isMain: false,
      branch: '77-foo',
      producer: 'operator',
      correlation: { number: 77, rung: 'branch-name' },
      unresolved: null,
    })
  })

  it('parses a detached entry with an agent-<hash> producer', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza([
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo-worktrees/agent-deadbeef',
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        '',
      ]),
    )
    const log = ok('2222222222222222222222222222222222222222 #77 fix the thing\n')
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list, log }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    const entry = result.entries[1]
    expect(entry).toMatchObject({
      branch: null,
      detached: true,
      producer: 'dispatched',
      correlation: { number: 77, rung: 'head-subject' },
    })
  })

  it('parses a bare entry', async () => {
    const calls: string[][] = []
    const list = ok(stanza(['worktree /repo', 'bare', '']))
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[0]).toMatchObject({ bare: true, head: null, branch: null })
  })

  it('parses locked with a reason', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '', 'worktree /repo-worktrees/other', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/wip', 'locked a manual reason', '']),
    )
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[1]).toMatchObject({ locked: true, lockReason: 'a manual reason' })
  })

  it('parses locked without a reason', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '', 'worktree /repo-worktrees/other', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/wip', 'locked', '']),
    )
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[1]).toMatchObject({ locked: true, lockReason: null })
  })

  it('parses prunable with its reason', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza([
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo-worktrees/gone',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/wip',
        'prunable gitdir file points to non-existent location',
        '',
      ]),
    )
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[1]).toMatchObject({ prunable: true, prunableReason: 'gitdir file points to non-existent location' })
  })

  it('reports insideMain: false for an entry outside the main worktree', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '', 'worktree /elsewhere/impl-77', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/77-foo', '']),
    )
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[1]?.insideMain).toBe(false)
  })

  it('handles CRLF line endings identically to LF', async () => {
    const lf = stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '']);
    const crlf = lf.split('\n').join('\r\n')
    const callsLf: string[][] = []
    const callsCrlf: string[][] = []
    const resultLf = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list: ok(lf) }, callsLf), now })
    const resultCrlf = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list: ok(crlf) }, callsCrlf), now })
    expect(resultCrlf).toEqual(resultLf)
  })

  it('normalizes a Windows-shaped path to native form', async () => {
    const calls: string[][] = []
    const list = ok(stanza(['worktree C:/repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '']))
    const win32PathOps = createPathOps('win32', { home: 'C:\\Users\\u' })
    const result = await readWorktrees({ repoRoot: 'C:\\repo', git: routedGit({ list }, calls), now, pathOps: win32PathOps })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[0]?.path).toBe('C:\\repo')
  })
})

describe('readWorktrees — absent-signal rules', () => {
  it('treats git config --get-regexp exit 1 as an empty upstream set, not a failure', async () => {
    const calls: string[][] = []
    const list = ok(stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '']))
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list, config: nonzero(1) }, calls), now })
    expect(result.ok).toBe(true)
  })

  it('degrades to subjectsAvailable: false when the batch git log call fails, without failing the whole read', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '', 'worktree /repo-worktrees/mystery', 'HEAD 2222222222222222222222222222222222222222', 'detached', '']),
    )
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list, log: nonzero(128, 'fatal: bad object') }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.subjectsAvailable).toBe(false)
    expect(result.entries[1]).toMatchObject({ correlation: null, unresolved: 'subjects-unavailable' })
  })

  it('reports no-rung-matched when subjects are available but nothing correlates', async () => {
    const calls: string[][] = []
    const list = ok(stanza(['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '', 'worktree /repo-worktrees/mystery', 'HEAD 2222222222222222222222222222222222222222', 'detached', '']))
    const log = ok('2222222222222222222222222222222222222222 not a pipeline commit\n')
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list, log }, calls), now })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[1]).toMatchObject({ correlation: null, unresolved: 'no-rung-matched' })
  })
})

describe('readWorktrees — failures', () => {
  it('maps exit 128 on worktree list to not-a-repository', async () => {
    const calls: string[][] = []
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list: nonzero(128, 'fatal: not a git repository') }, calls), now })
    expect(result).toMatchObject({ ok: false, kind: 'not-a-repository' })
  })

  it('reports not-found without throwing when git itself is missing', async () => {
    const git: GitRunner = () => Promise.resolve(NOT_FOUND)
    const result = await readWorktrees({ repoRoot: '/repo', git, now })
    expect(result).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('readWorktrees — call budget', () => {
  it('makes exactly three git calls for a five-worktree repository', async () => {
    const calls: string[][] = []
    const list = ok(
      stanza([
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo-worktrees/impl-77',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/77-foo',
        '',
        'worktree /repo-worktrees/agent-deadbeef',
        'HEAD 3333333333333333333333333333333333333333',
        'detached',
        '',
        'worktree /repo-worktrees/locked-one',
        'HEAD 4444444444444444444444444444444444444444',
        'branch refs/heads/other',
        'locked a manual reason',
        '',
        'worktree /repo-worktrees/locked-two',
        'HEAD 5555555555555555555555555555555555555555',
        'branch refs/heads/another',
        'locked',
        '',
      ]),
    )
    const result = await readWorktrees({ repoRoot: '/repo', git: routedGit({ list }, calls), now })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[0]?.[0]).toBe('worktree')
    expect(calls[1]?.[0]).toBe('config')
    expect(calls[2]?.[0]).toBe('log')
  })
})

describe('readWorktrees — integration', () => {
  it('resolves this checkout when git is available', async (ctx) => {
    const result = await readWorktrees({ repoRoot: process.cwd() })
    if (!result.ok) {
      if (result.kind === 'not-found') {
        ctx.skip()
        return
      }
      throw new Error(`unexpected failure: ${JSON.stringify(result)}`)
    }
    const mainEntries = result.entries.filter((entry) => entry.isMain)
    expect(mainEntries).toHaveLength(1)
    expect(hostPathOps.samePath(result.mainPath, process.cwd()) || hostPathOps.contains(result.mainPath, process.cwd()) || hostPathOps.contains(process.cwd(), result.mainPath)).toBe(true)
    for (const entry of result.entries) {
      expect(hostPathOps.samePath(entry.path, hostPathOps.toNative(entry.path))).toBe(true)
    }
  })
})

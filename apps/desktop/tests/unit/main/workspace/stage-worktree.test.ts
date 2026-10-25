import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult, GitRunner } from '@/types/platform'
import type { CreateStageWorktreeParams } from '@/types/workspace'
import { branchSlug, createStageWorktree, releaseStageBranch, sweepSessionBranches } from '@/main/workspace/stage-worktree'
import { makeTempDir } from '../../../fixtures/fs'

function ok(stdout = ''): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(code: number, stderr = ''): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

type Responder = (args: readonly string[]) => CommandResult | undefined

function recorder(respond: Responder = () => undefined): { readonly git: GitRunner; readonly calls: string[][] } {
  const calls: string[][] = []
  const git: GitRunner = (args) => {
    calls.push([...args])
    return Promise.resolve(respond(args) ?? ok())
  }
  return { git, calls }
}

const START_SHA = 'cafe0001'

function withStart(extra: Responder = () => undefined): Responder {
  return (args) => extra(args) ?? (args[0] === 'rev-parse' && args[1] === '--verify' ? ok(`${START_SHA}\n`) : undefined)
}

function forEachRef(branch: string, tip: string, worktreePath = ''): CommandResult {
  return ok(`refs/heads/${branch}\t${tip}\t${worktreePath}\n`)
}

async function params(overrides: Partial<CreateStageWorktreeParams> & { readonly git: GitRunner }): Promise<CreateStageWorktreeParams> {
  const root = await makeTempDir()
  return { root, agent: 'impl', number: 467, integration: 'dev', target: { kind: 'issue', title: 'Stage worktrees use the issue branch' }, random: () => 'abcdef0123', ...overrides }
}

function argvOf(calls: readonly string[][], ...prefix: string[]): string[][] {
  return calls.filter((call) => prefix.every((part, i) => call[i] === part))
}

describe('branchSlug', () => {
  it('lowercases and collapses every run of other characters to one dash', () => {
    expect(branchSlug('E16 · Stage, use: the issue’s branch!')).toBe('e16-stage-use-the-issue-s-branch')
  })

  it('trims leading and trailing dashes', () => {
    expect(branchSlug('  --Hello--  ')).toBe('hello')
  })

  it('is `work` when nothing alphanumeric is left', () => {
    expect(branchSlug('···')).toBe('work')
    expect(branchSlug('')).toBe('work')
  })

  it('cuts a long title at a dash within 40 characters', () => {
    const slug = branchSlug('Stage worktrees use the issue branch and stop leaking session branches')
    expect(slug).toBe('stage-worktrees-use-the-issue-branch-and')
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('keeps all 40 characters when the next character is a dash', () => {
    const forty = 'a'.repeat(40)
    expect(branchSlug(`${forty} tail`)).toBe(forty)
  })

  it('hard-cuts a long single word', () => {
    expect(branchSlug('a'.repeat(60))).toBe('a'.repeat(40))
  })
})

describe('createStageWorktree — start point and branch per stage', () => {
  it('plan: detached at the integration branch, no branch, no portBase', async () => {
    const { git, calls } = recorder(withStart())
    const p = await params({ git, agent: 'plan' })
    const result = await createStageWorktree(p)
    const path = join(p.root, '.claude', 'worktrees', 'plan-467')
    expect(result).toEqual({ ok: true, path, branch: null, baseSha: START_SHA, baseLabel: 'origin/dev' })
    expect(calls[0]).toEqual(['fetch', 'origin'])
    expect(argvOf(calls, 'rev-parse', '--verify')[0]).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/dev^{commit}'])
    expect(argvOf(calls, 'worktree')).toEqual([['worktree', 'add', '--detach', path, START_SHA]])
    expect(argvOf(calls, 'config')).toEqual([])
  })

  it('review: detached at the pull request head', async () => {
    const { git, calls } = recorder(withStart())
    const p = await params({ git, agent: 'review', number: 500, target: { kind: 'pr', headRefName: '467-stage-worktrees' } })
    const result = await createStageWorktree(p)
    expect(result).toMatchObject({ ok: true, branch: null, baseLabel: 'origin/467-stage-worktrees' })
    expect(argvOf(calls, 'rev-parse', '--verify')[0]).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/467-stage-worktrees^{commit}'])
    expect(argvOf(calls, 'worktree')[0]?.[2]).toBe('--detach')
  })

  it('revise: the pull request head as a branch, with portBase recorded', async () => {
    const { git, calls } = recorder(withStart())
    const p = await params({ git, agent: 'revise', number: 500, target: { kind: 'pr', headRefName: '467-stage-worktrees' } })
    const result = await createStageWorktree(p)
    const path = join(p.root, '.claude', 'worktrees', 'revise-500')
    expect(result).toEqual({ ok: true, path, branch: '467-stage-worktrees', baseSha: START_SHA, baseLabel: '467-stage-worktrees' })
    expect(argvOf(calls, 'worktree')).toEqual([['worktree', 'add', '-b', '467-stage-worktrees', path, START_SHA]])
    expect(argvOf(calls, 'config')).toEqual([['config', 'branch.467-stage-worktrees.portBase', START_SHA]])
  })

  it.each(['review', 'revise'] as const)('%s: refuses a pull request with no head branch', async (agent) => {
    const { git, calls } = recorder(withStart())
    const p = await params({ git, agent, number: 500, target: { kind: 'pr', headRefName: null } })
    expect(await createStageWorktree(p)).toEqual({ ok: false, message: 'PR #500 has no head branch to check out.' })
    expect(argvOf(calls, 'worktree')).toEqual([])
  })

  it('impl with no remote match: a fresh <N>-<slug> branch from the integration branch', async () => {
    const { git, calls } = recorder(withStart())
    const p = await params({ git })
    const result = await createStageWorktree(p)
    const path = join(p.root, '.claude', 'worktrees', 'impl-467')
    expect(result).toEqual({ ok: true, path, branch: '467-stage-worktrees-use-the-issue-branch', baseSha: START_SHA, baseLabel: '467-stage-worktrees-use-the-issue-branch' })
    expect(argvOf(calls, 'ls-remote')).toEqual([['ls-remote', '--heads', 'origin', 'refs/heads/467-*']])
    expect(argvOf(calls, 'check-ref-format')).toEqual([['check-ref-format', '--branch', '467-stage-worktrees-use-the-issue-branch']])
    expect(argvOf(calls, 'rev-parse', '--verify')[0]).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/dev^{commit}'])
    expect(argvOf(calls, 'worktree')).toEqual([['worktree', 'add', '-b', '467-stage-worktrees-use-the-issue-branch', path, START_SHA]])
  })

  it('impl with exactly one remote match: adopts that name and starts at it', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'ls-remote' ? ok('1111\trefs/heads/467-earlier-attempt\n') : undefined)))
    const result = await createStageWorktree(await params({ git }))
    expect(result).toMatchObject({ ok: true, branch: '467-earlier-attempt' })
    expect(argvOf(calls, 'rev-parse', '--verify')[0]).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/467-earlier-attempt^{commit}'])
    expect(argvOf(calls, 'check-ref-format')).toEqual([])
  })

  it('impl with two matches: derives the slug and starts from the integration branch', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'ls-remote' ? ok('1\trefs/heads/467-a\n2\trefs/heads/467-b\n') : undefined)))
    const result = await createStageWorktree(await params({ git }))
    expect(result).toMatchObject({ ok: true, branch: '467-stage-worktrees-use-the-issue-branch' })
    expect(argvOf(calls, 'rev-parse', '--verify')[0]?.[2]).toBe('refs/remotes/origin/dev^{commit}')
  })

  it('impl with two matches, one of them the derived name: starts at that remote branch', async () => {
    const derived = '467-stage-worktrees-use-the-issue-branch'
    const { git, calls } = recorder(withStart((args) => (args[0] === 'ls-remote' ? ok(`1\trefs/heads/467-a\n2\trefs/heads/${derived}\n`) : undefined)))
    await createStageWorktree(await params({ git }))
    expect(argvOf(calls, 'rev-parse', '--verify')[0]?.[2]).toBe(`refs/remotes/origin/${derived}^{commit}`)
  })

  it('impl: refuses when the remote branch listing fails', async () => {
    const { git } = recorder(withStart((args) => (args[0] === 'ls-remote' ? nonzero(128, 'fatal: unable to access') : undefined)))
    const result = await createStageWorktree(await params({ git }))
    expect(result.ok).toBe(false)
  })

  it('impl: refuses a derived name git rejects', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'check-ref-format' ? nonzero(1) : undefined)))
    const result = await createStageWorktree(await params({ git }))
    expect(result).toEqual({ ok: false, message: '"467-stage-worktrees-use-the-issue-branch" is not a valid branch name.' })
    expect(argvOf(calls, 'worktree')).toEqual([])
  })
})

describe('createStageWorktree — refusals', () => {
  it('a failed fetch refuses before anything else runs', async () => {
    const { git, calls } = recorder((args) => (args[0] === 'fetch' ? nonzero(128, 'fatal: unable to access') : undefined))
    const result = await createStageWorktree(await params({ git }))
    expect(result).toEqual({ ok: false, message: "Couldn't fetch origin: fatal: unable to access. Check the network and the remote, then retry." })
    expect(calls).toHaveLength(1)
  })

  it('a start point that does not resolve refuses', async () => {
    const { git, calls } = recorder((args) => (args[0] === 'rev-parse' ? nonzero(128, 'fatal: Needed a single revision') : undefined))
    const result = await createStageWorktree(await params({ git, agent: 'plan' }))
    expect(result.ok).toBe(false)
    expect(argvOf(calls, 'worktree')).toEqual([])
  })

  it('reports a failed worktree add', async () => {
    const { git } = recorder(withStart((args) => (args[0] === 'worktree' ? nonzero(128, 'fatal: boom') : undefined)))
    const result = await createStageWorktree(await params({ git, agent: 'plan' }))
    expect(result).toEqual({ ok: false, message: 'git worktree add failed: fatal: boom' })
  })

  it('removes the new worktree and its branch when the ignore check fails', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'check-ignore' ? nonzero(128, 'fatal: boom') : undefined)))
    const p = await params({ git })
    const result = await createStageWorktree(p)
    const path = join(p.root, '.claude', 'worktrees', 'impl-467')
    expect(result.ok).toBe(false)
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([['worktree', 'remove', '--force', path]])
    expect(argvOf(calls, 'branch')).toEqual([['branch', '-D', '467-stage-worktrees-use-the-issue-branch']])
  })

  it('removes the new worktree and its branch when portBase cannot be recorded', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'config' ? nonzero(1, 'error: could not lock config file') : undefined)))
    const p = await params({ git })
    const result = await createStageWorktree(p)
    const path = join(p.root, '.claude', 'worktrees', 'impl-467')
    expect(result).toEqual({ ok: false, message: 'could not record portBase: error: could not lock config file' })
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([['worktree', 'remove', '--force', path]])
    expect(argvOf(calls, 'branch')).toEqual([['branch', '-D', '467-stage-worktrees-use-the-issue-branch']])
  })

  it('keeps a detached stage with no branch to delete', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'check-ignore' ? nonzero(128, 'fatal: boom') : undefined)))
    const result = await createStageWorktree(await params({ git, agent: 'plan' }))
    expect(result.ok).toBe(false)
    expect(argvOf(calls, 'worktree', 'remove')).toHaveLength(1)
    expect(argvOf(calls, 'branch')).toEqual([])
  })

  it('never deletes a local branch that existed before the call', async () => {
    const derived = '467-stage-worktrees-use-the-issue-branch'
    const { git, calls } = recorder(
      withStart((args) => {
        if (args[0] === 'for-each-ref') return forEachRef(derived, 'aaaa')
        if (args[0] === 'check-ignore') return nonzero(128, 'fatal: boom')
        return undefined
      }),
    )
    const result = await createStageWorktree(await params({ git }))
    expect(result.ok).toBe(false)
    expect(argvOf(calls, 'worktree', 'remove')).toHaveLength(1)
    expect(argvOf(calls, 'branch')).toEqual([])
  })
})

describe('createStageWorktree — the folder', () => {
  it('suffixes the folder when it already exists', async () => {
    const { git, calls } = recorder(withStart())
    const p = await params({ git, agent: 'plan' })
    await mkdir(join(p.root, '.claude', 'worktrees', 'plan-467'), { recursive: true })
    const result = await createStageWorktree(p)
    const path = join(p.root, '.claude', 'worktrees', 'plan-467-abcdef')
    expect(result).toMatchObject({ ok: true, path })
    expect(argvOf(calls, 'worktree')).toEqual([['worktree', 'add', '--detach', path, START_SHA]])
    expect(argvOf(calls, 'check-ignore')[0]).toEqual(['check-ignore', '-q', '.claude/worktrees/plan-467-abcdef'])
  })
})

describe('createStageWorktree — a local branch of the same name', () => {
  const derived = '467-stage-worktrees-use-the-issue-branch'

  it('refuses when it is checked out in another worktree', async () => {
    const { git } = recorder(withStart((args) => (args[0] === 'for-each-ref' ? forEachRef(derived, 'aaaa', '/elsewhere/impl-467') : undefined)))
    const result = await createStageWorktree(await params({ git }))
    expect(result).toEqual({ ok: false, message: `Branch ${derived} is checked out in /elsewhere/impl-467. Resume or restart that stage first.` })
  })

  it('fast-forwards it with -B when its tip is an ancestor of the start', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'for-each-ref' ? forEachRef(derived, 'aaaa') : undefined)))
    const p = await params({ git })
    const result = await createStageWorktree(p)
    expect(result.ok).toBe(true)
    expect(argvOf(calls, 'merge-base')).toEqual([['merge-base', '--is-ancestor', 'aaaa', 'refs/remotes/origin/dev']])
    expect(argvOf(calls, 'worktree')[0]?.slice(0, 4)).toEqual(['worktree', 'add', '-B', derived])
  })

  it('refuses when it holds commits that are not on the start', async () => {
    const { git, calls } = recorder(
      withStart((args) => {
        if (args[0] === 'for-each-ref') return forEachRef(derived, 'aaaa')
        if (args[0] === 'merge-base') return nonzero(1)
        return undefined
      }),
    )
    const result = await createStageWorktree(await params({ git }))
    expect(result).toEqual({ ok: false, message: `Local branch ${derived} has commits that aren't on origin. Push or delete it, then retry.` })
    expect(argvOf(calls, 'worktree')).toEqual([])
  })

  it('refuses rather than guessing when merge-base itself fails', async () => {
    const { git, calls } = recorder(
      withStart((args) => {
        if (args[0] === 'for-each-ref') return forEachRef(derived, 'aaaa')
        if (args[0] === 'merge-base') return nonzero(128, 'fatal: bad object')
        return undefined
      }),
    )
    const result = await createStageWorktree(await params({ git }))
    expect(result.ok).toBe(false)
    expect(argvOf(calls, 'worktree')).toEqual([])
  })

  it('ignores a branch that merely shares the prefix', async () => {
    const { git, calls } = recorder(withStart((args) => (args[0] === 'for-each-ref' ? forEachRef(`${derived}/nested`, 'aaaa', '/elsewhere') : undefined)))
    const result = await createStageWorktree(await params({ git }))
    expect(result.ok).toBe(true)
    expect(argvOf(calls, 'worktree')[0]?.[2]).toBe('-b')
  })
})

describe('releaseStageBranch', () => {
  const base = { root: '/repo', branch: '467-x', baseSha: 'base1' }

  it('deletes a branch still at its base', async () => {
    const { git, calls } = recorder((args) => (args[0] === 'rev-parse' ? ok('base1\n') : undefined))
    expect(await releaseStageBranch({ ...base, git })).toBe('deleted')
    expect(argvOf(calls, 'branch')).toEqual([['branch', '-D', '467-x']])
    expect(argvOf(calls, 'merge-base')).toEqual([])
  })

  it('deletes a branch whose tip is already on origin', async () => {
    const { git, calls } = recorder((args) => (args[0] === 'rev-parse' ? ok('tip9\n') : undefined))
    expect(await releaseStageBranch({ ...base, git })).toBe('deleted')
    expect(argvOf(calls, 'merge-base')).toEqual([['merge-base', '--is-ancestor', 'tip9', 'refs/remotes/origin/467-x']])
  })

  it('keeps a branch holding commits that are not on origin', async () => {
    const { git, calls } = recorder((args) => {
      if (args[0] === 'rev-parse') return ok('tip9\n')
      if (args[0] === 'merge-base') return nonzero(1)
      return undefined
    })
    expect(await releaseStageBranch({ ...base, git })).toBe('kept')
    expect(argvOf(calls, 'branch')).toEqual([])
  })

  it('keeps the branch when the remote-tracking ref cannot be read', async () => {
    const { git } = recorder((args) => {
      if (args[0] === 'rev-parse') return ok('tip9\n')
      if (args[0] === 'merge-base') return nonzero(128, 'fatal: Not a valid object name')
      return undefined
    })
    expect(await releaseStageBranch({ ...base, git })).toBe('kept')
  })

  it('keeps the branch when git branch -D fails', async () => {
    const { git } = recorder((args) => {
      if (args[0] === 'rev-parse') return ok('base1\n')
      if (args[0] === 'branch') return nonzero(1, "error: Cannot delete branch '467-x' checked out at '/elsewhere'")
      return undefined
    })
    expect(await releaseStageBranch({ ...base, git })).toBe('kept')
  })

  it('treats an already-absent branch as deleted', async () => {
    const { git, calls } = recorder((args) => (args[0] === 'rev-parse' ? nonzero(1) : undefined))
    expect(await releaseStageBranch({ ...base, git })).toBe('deleted')
    expect(argvOf(calls, 'branch')).toEqual([])
  })

  it('keeps the branch when rev-parse fails for any other reason', async () => {
    const { git } = recorder((args) => (args[0] === 'rev-parse' ? nonzero(128, 'fatal: not a git repository') : undefined))
    expect(await releaseStageBranch({ ...base, git })).toBe('kept')
  })
})

describe('sweepSessionBranches', () => {
  function listing(...rows: readonly (readonly [string, string, string])[]): CommandResult {
    return ok(rows.map(([branch, tip, path]) => `refs/heads/${branch}\t${tip}\t${path}`).join('\n') + '\n')
  }

  it('does nothing once the marker says done', async () => {
    const { git, calls } = recorder((args) => (args[0] === 'config' && args[1] === '--get' ? ok('done\n') : undefined))
    expect(await sweepSessionBranches({ root: '/repo', git })).toEqual({ done: true, deleted: [] })
    expect(calls).toHaveLength(1)
  })

  it('deletes a branch still at its recorded portBase', async () => {
    const { git, calls } = recorder((args) => {
      if (args[0] === 'config' && args[1] === '--get' && args[2] === 'port.sessionBranchSweep') return nonzero(1)
      if (args[0] === 'for-each-ref') return listing(['session/aaa111', 'tip1', ''])
      if (args[0] === 'config' && args[1] === '--get') return ok('tip1\n')
      return undefined
    })
    expect(await sweepSessionBranches({ root: '/repo', git })).toEqual({ done: true, deleted: ['session/aaa111'] })
    expect(argvOf(calls, 'branch')).toEqual([['branch', '-D', 'session/aaa111']])
    expect(argvOf(calls, 'config').at(-1)).toEqual(['config', 'port.sessionBranchSweep', 'done'])
  })

  it('deletes a branch whose tip any remote branch contains', async () => {
    const { git } = recorder((args) => {
      if (args[0] === 'config' && args[1] === '--get') return nonzero(1)
      if (args[0] === 'for-each-ref') return listing(['session/bbb222', 'tip2', ''])
      if (args[0] === 'branch' && args[1] === '-r') return ok('  origin/467-x\n')
      return undefined
    })
    expect((await sweepSessionBranches({ root: '/repo', git })).deleted).toEqual(['session/bbb222'])
  })

  it('keeps a branch with unpublished commits', async () => {
    const { git, calls } = recorder((args) => {
      if (args[0] === 'config' && args[1] === '--get') return nonzero(1)
      if (args[0] === 'for-each-ref') return listing(['session/ccc333', 'tip3', ''])
      if (args[0] === 'branch' && args[1] === '-r') return ok('')
      return undefined
    })
    expect(await sweepSessionBranches({ root: '/repo', git })).toEqual({ done: true, deleted: [] })
    expect(argvOf(calls, 'branch', '-D')).toEqual([])
  })

  it('skips a branch checked out in any worktree', async () => {
    const { git, calls } = recorder((args) => {
      if (args[0] === 'config' && args[1] === '--get') return nonzero(1)
      if (args[0] === 'for-each-ref') return listing(['session/ddd444', 'tip4', '/repo/.claude/worktrees/session-ddd444'])
      return undefined
    })
    expect(await sweepSessionBranches({ root: '/repo', git })).toEqual({ done: true, deleted: [] })
    expect(argvOf(calls, 'branch')).toEqual([])
  })

  it('leaves the marker unset when any branch could not be judged, and still sweeps the rest', async () => {
    const { git, calls } = recorder((args) => {
      if (args[0] === 'config' && args[1] === '--get' && args[2] === 'port.sessionBranchSweep') return nonzero(1)
      if (args[0] === 'for-each-ref') return listing(['session/eee555', 'tip5', ''], ['session/fff666', 'tip6', ''])
      if (args[0] === 'config' && args[1] === '--get') return args[2] === 'branch.session/eee555.portBase' ? nonzero(128, 'fatal: broken') : ok('tip6\n')
      return undefined
    })
    expect(await sweepSessionBranches({ root: '/repo', git })).toEqual({ done: false, deleted: ['session/fff666'] })
    expect(argvOf(calls, 'config').some((call) => call[1] === 'port.sessionBranchSweep' && call[2] === 'done')).toBe(false)
  })

  it('leaves the marker unset when the branch listing fails', async () => {
    const { git } = recorder((args) => {
      if (args[0] === 'config' && args[1] === '--get') return nonzero(1)
      if (args[0] === 'for-each-ref') return nonzero(128, 'fatal: boom')
      return undefined
    })
    expect(await sweepSessionBranches({ root: '/repo', git })).toEqual({ done: false, deleted: [] })
  })
})

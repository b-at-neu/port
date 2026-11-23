import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { readWorktrees } from '@/main/repos/local/worktrees'
import type { GitRunner } from '@/types/platform'
import { createFakeClock } from '../../../support/fake-platform'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(code: number, stderr = ''): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: ['/usr/bin/git'] }
const MAIN = ['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '']
const SHA2 = '2222222222222222222222222222222222222222'

interface Router {
  readonly list?: CommandResult
  readonly config?: CommandResult
  readonly log?: CommandResult
}

/** Routes by the git subcommand, recording every call so a test can assert the exact call budget. */
function routedGit(router: Router, calls: string[][]): GitRunner {
  return (args) => {
    calls.push([...args])
    if (args[0] === 'worktree') return Promise.resolve(router.list ?? ok(''))
    if (args[0] === 'config') return Promise.resolve(router.config ?? nonzero(1))
    if (args[0] === 'log') return Promise.resolve(router.log ?? ok(''))
    return Promise.reject(new Error(`unexpected call: ${args.join(' ')}`))
  }
}

function read(router: Router, calls: string[][] = []) {
  return readWorktrees({ git: routedGit(router, calls), clock: createFakeClock() }, '/repo')
}

function stanzas(...entries: readonly (readonly string[])[]): CommandResult {
  return ok([...MAIN, ...entries.flatMap((entry) => [...entry, ''])].join('\n'))
}

const linked = (path: string, ...rest: readonly string[]): readonly string[] => [`worktree ${path}`, `HEAD ${SHA2}`, ...rest]

describe('readWorktrees — field mapping', () => {
  it.each([
    {
      name: 'a branch-carrying operator worktree',
      list: stanzas(linked('/repo-worktrees/impl-77', 'branch refs/heads/77-foo')),
      expected: { path: '/repo-worktrees/impl-77', isMain: false, branch: '77-foo', producer: 'operator', correlation: { number: 77, rung: 'branch-name' }, unresolved: null },
    },
    {
      name: 'a bare main entry',
      list: ok(['worktree /repo', 'bare', ''].join('\n')),
      index: 0,
      expected: { bare: true, head: null, branch: null },
    },
    { name: 'locked with a reason', list: stanzas(linked('/repo-worktrees/other', 'branch refs/heads/wip', 'locked a manual reason')), expected: { locked: true, lockReason: 'a manual reason' } },
    { name: 'locked without a reason', list: stanzas(linked('/repo-worktrees/other', 'branch refs/heads/wip', 'locked')), expected: { locked: true, lockReason: null } },
    {
      name: 'prunable with its reason',
      list: stanzas(linked('/repo-worktrees/gone', 'branch refs/heads/wip', 'prunable gitdir file points to non-existent location')),
      expected: { prunable: true, prunableReason: 'gitdir file points to non-existent location' },
    },
    { name: 'an entry outside the main worktree', list: stanzas(linked('/elsewhere/impl-77', 'branch refs/heads/77-foo')), expected: { insideMain: false } },
  ])('parses $name', async ({ list, expected, index }) => {
    const result = await read({ list })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[index ?? 1]).toMatchObject(expected)
  })

  it('parses a detached agent worktree and correlates it by head subject', async () => {
    const list = stanzas(linked('/repo-worktrees/agent-deadbeef', 'detached'))
    const result = await read({ list, log: ok(`${SHA2} #77 fix the thing\n`) })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries[1]).toMatchObject({ branch: null, detached: true, producer: 'dispatched', correlation: { number: 77, rung: 'head-subject' } })
  })

  it('handles CRLF line endings identically to LF', async () => {
    const lf = MAIN.join('\n')
    expect(await read({ list: ok(lf.split('\n').join('\r\n')) })).toEqual(await read({ list: ok(lf) }))
  })
})

describe('readWorktrees — absent-signal rules', () => {
  it('treats git config --get-regexp exit 1 as an empty upstream set, not a failure', async () => {
    expect((await read({ list: stanzas(), config: nonzero(1) })).ok).toBe(true)
  })

  it.each([
    { name: 'subjectsAvailable: false when the batch git log call fails', log: nonzero(128, 'fatal: bad object'), available: false, unresolved: 'subjects-unavailable' },
    { name: 'no-rung-matched when subjects are available but nothing correlates', log: ok(`${SHA2} not a pipeline commit\n`), available: true, unresolved: 'no-rung-matched' },
  ])('degrades to $name', async ({ log, available, unresolved }) => {
    const result = await read({ list: stanzas(linked('/repo-worktrees/mystery', 'detached')), log })
    if (!result.ok) throw new Error('expected ok')
    expect(result.subjectsAvailable).toBe(available)
    expect(result.entries[1]).toMatchObject({ correlation: null, unresolved })
  })
})

describe('readWorktrees — failures', () => {
  it('maps exit 128 on worktree list to not-a-repository', async () => {
    expect(await read({ list: nonzero(128, 'fatal: not a git repository') })).toMatchObject({ ok: false, kind: 'not-a-repository' })
  })

  it('reports not-found without throwing when git itself is missing', async () => {
    expect(await read({ list: NOT_FOUND })).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('readWorktrees — call budget', () => {
  it('makes exactly three git calls for a five-worktree repository', async () => {
    const calls: string[][] = []
    const list = stanzas(
      linked('/repo-worktrees/impl-77', 'branch refs/heads/77-foo'),
      linked('/repo-worktrees/agent-deadbeef', 'detached'),
      linked('/repo-worktrees/locked-one', 'branch refs/heads/other', 'locked a manual reason'),
      linked('/repo-worktrees/locked-two', 'branch refs/heads/another', 'locked'),
    )
    expect((await read({ list }, calls)).ok).toBe(true)
    expect(calls.map((call) => call[0])).toEqual(['worktree', 'config', 'log'])
  })
})

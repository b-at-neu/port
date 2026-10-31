import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { defaultRefName, permissionsStateOf, readAtDefaultRef, refsCarryingConfig } from '@/main/registry/harness'
import type { GitRunner } from '@/types/platform'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(code: number, stderr: string): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: [] }

describe('readAtDefaultRef', () => {
  it('reads the blob straight from origin/HEAD', async () => {
    const calls: string[][] = []
    const git: GitRunner = (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse') return Promise.resolve(ok('deadbeef\n'))
      return Promise.resolve(ok('{"repo":"o/n"}'))
    }
    expect(await readAtDefaultRef(git, '/repo', '.claude/port.config.json')).toEqual({ ok: true, text: '{"repo":"o/n"}' })
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD'],
      ['show', 'refs/remotes/origin/HEAD:.claude/port.config.json'],
    ])
  })

  it('restores a missing origin/HEAD once with set-head, then reads', async () => {
    const calls: string[][] = []
    let restored = false
    const git: GitRunner = (args) => {
      calls.push([...args])
      if (args[0] === 'remote') {
        restored = true
        return Promise.resolve(ok(''))
      }
      if (args[0] === 'rev-parse') return Promise.resolve(restored ? ok('deadbeef\n') : nonzero(1, ''))
      return Promise.resolve(ok('x'))
    }
    expect(await readAtDefaultRef(git, '/repo', 'CLAUDE.md')).toEqual({ ok: true, text: 'x' })
    expect(calls.filter((call) => call[0] === 'remote')).toEqual([['remote', 'set-head', 'origin', '--auto']])
  })

  it('reports ref-unreadable with git’s own message when set-head fails', async () => {
    const git: GitRunner = (args) => Promise.resolve(args[0] === 'rev-parse' ? nonzero(1, '') : nonzero(128, "error: No such remote 'origin'"))
    expect(await readAtDefaultRef(git, '/repo', 'CLAUDE.md')).toEqual({ ok: false, kind: 'ref-unreadable', message: "error: No such remote 'origin'" })
  })

  it('reports ref-unreadable when origin/HEAD is still missing after set-head', async () => {
    const git: GitRunner = (args) => Promise.resolve(args[0] === 'remote' ? ok('') : nonzero(1, ''))
    const result = await readAtDefaultRef(git, '/repo', 'CLAUDE.md')
    expect(result).toEqual({ ok: false, kind: 'ref-unreadable', message: 'origin/HEAD is not set' })
  })

  it('maps both "does not exist" wordings to not-found', async () => {
    for (const stderr of ["fatal: path 'CLAUDE.md' does not exist in 'refs/remotes/origin/HEAD'", "fatal: path 'CLAUDE.md' exists on disk, but not in 'refs/remotes/origin/HEAD'"]) {
      const git: GitRunner = (args) => Promise.resolve(args[0] === 'rev-parse' ? ok('deadbeef\n') : nonzero(128, stderr))
      const result = await readAtDefaultRef(git, '/repo', 'CLAUDE.md')
      expect(result).toMatchObject({ ok: false, kind: 'not-found' })
    }
  })

  it('maps any other show failure to unreadable', async () => {
    const git: GitRunner = (args) => Promise.resolve(args[0] === 'rev-parse' ? ok('deadbeef\n') : nonzero(128, 'fatal: unable to read blob'))
    expect(await readAtDefaultRef(git, '/repo', 'CLAUDE.md')).toEqual({ ok: false, kind: 'unreadable', message: 'fatal: unable to read blob' })
  })

  it('maps a failure to run git at all to unreadable', async () => {
    const git: GitRunner = (args) => Promise.resolve(args[0] === 'rev-parse' ? ok('deadbeef\n') : NOT_FOUND)
    expect(await readAtDefaultRef(git, '/repo', 'CLAUDE.md')).toEqual({ ok: false, kind: 'unreadable', message: 'not-found' })
  })
})

describe('defaultRefName', () => {
  it('names what origin/HEAD points at', async () => {
    const git: GitRunner = (args) => {
      expect(args).toEqual(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      return Promise.resolve(ok('origin/dev\n'))
    }
    expect(await defaultRefName(git, '/repo')).toBe('origin/dev')
  })

  it('is null when the symref cannot be resolved', async () => {
    const git: GitRunner = () => Promise.resolve(nonzero(128, 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'))
    expect(await defaultRefName(git, '/repo')).toBeNull()
  })
})

describe('refsCarryingConfig', () => {
  it('reports no carrying refs when rev-list finds nothing', async () => {
    const git: GitRunner = (args) => {
      if (args[0] === 'rev-list') return Promise.resolve(ok(''))
      throw new Error(`unexpected call: ${args.join(' ')}`)
    }
    expect(await refsCarryingConfig(git, '/repo')).toEqual({ ok: true, refs: [] })
  })

  it('excludes a candidate rejected by ls-tree', async () => {
    const git: GitRunner = (args) => {
      if (args[0] === 'rev-list') return Promise.resolve(ok('deadbeef\n'))
      if (args[0] === 'branch') return Promise.resolve(ok('dev\nstale-branch\n'))
      if (args[0] === 'ls-tree') {
        const ref = args[2]
        return Promise.resolve(ref === 'dev' ? ok('.claude/port.config.json\n') : ok(''))
      }
      throw new Error(`unexpected call: ${args.join(' ')}`)
    }
    expect(await refsCarryingConfig(git, '/repo')).toEqual({ ok: true, refs: ['dev'] })
  })

  it('caps candidates at 20', async () => {
    const allBranches = Array.from({ length: 25 }, (_, i) => `branch-${i}`).join('\n')
    let lsTreeCalls = 0
    const git: GitRunner = (args) => {
      if (args[0] === 'rev-list') return Promise.resolve(ok('deadbeef\n'))
      if (args[0] === 'branch') return Promise.resolve(ok(`${allBranches}\n`))
      if (args[0] === 'ls-tree') {
        lsTreeCalls++
        return Promise.resolve(ok('.claude/port.config.json\n'))
      }
      throw new Error(`unexpected call: ${args.join(' ')}`)
    }
    const result = await refsCarryingConfig(git, '/repo')
    expect(result).toEqual({ ok: true, refs: Array.from({ length: 20 }, (_, i) => `branch-${i}`) })
    expect(lsTreeCalls).toBe(20)
  })

  it('reports unavailable when every call returns not-found, without throwing', async () => {
    const git: GitRunner = () => Promise.resolve(NOT_FOUND)
    expect(await refsCarryingConfig(git, '/repo')).toEqual({ ok: false })
  })
})

describe('permissionsStateOf', () => {
  it('reports missing when the settings file is not on the default branch', () => {
    expect(permissionsStateOf({ ok: false, kind: 'not-found', message: 'gone' })).toBe('missing')
  })

  it('reports missing when the settings file is unreadable', () => {
    expect(permissionsStateOf({ ok: false, kind: 'unreadable', message: 'io' })).toBe('missing')
  })

  it('reports missing when the settings file is not JSON', () => {
    expect(permissionsStateOf({ ok: true, text: '{nope' })).toBe('missing')
  })

  it('reports missing when permissions.allow is absent', () => {
    expect(permissionsStateOf({ ok: true, text: JSON.stringify({}) })).toBe('missing')
  })

  it('reports empty when permissions.allow is an empty array', () => {
    expect(permissionsStateOf({ ok: true, text: JSON.stringify({ permissions: { allow: [] } }) })).toBe('empty')
  })

  it('reports populated when permissions.allow is non-empty', () => {
    expect(permissionsStateOf({ ok: true, text: JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }) })).toBe('populated')
  })
})

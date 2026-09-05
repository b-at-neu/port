import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform'
import { currentBranch, permissionsState, refsCarryingConfig } from './harness'
import type { GitRunner } from './harness'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-registry-harness-'))
}

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: [] }

describe('currentBranch', () => {
  it('reports a normal branch', async () => {
    const git: GitRunner = (args) => {
      expect(args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
      return Promise.resolve(ok('main\n'))
    }
    expect(await currentBranch(git, '/repo')).toEqual({ kind: 'branch', name: 'main' })
  })

  it('promotes a literal HEAD to detached-head with the short sha', async () => {
    const git: GitRunner = (args) => {
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return Promise.resolve(ok('HEAD\n'))
      if (args[0] === 'rev-parse' && args.includes('--short')) return Promise.resolve(ok('abc1234\n'))
      throw new Error(`unexpected call: ${args.join(' ')}`)
    }
    expect(await currentBranch(git, '/repo')).toEqual({ kind: 'detached', sha: 'abc1234' })
  })

  it('reports unavailable when git itself is not found, without throwing', async () => {
    const git: GitRunner = () => Promise.resolve(NOT_FOUND)
    expect(await currentBranch(git, '/repo')).toEqual({ kind: 'unavailable' })
  })

  it('reports unavailable when the second call (resolving the detached sha) fails', async () => {
    const git: GitRunner = (args) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve(ok('HEAD\n'))
      return Promise.resolve(NOT_FOUND)
    }
    expect(await currentBranch(git, '/repo')).toEqual({ kind: 'unavailable' })
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

describe('permissionsState', () => {
  it('reports missing when .claude/settings.json does not exist', async () => {
    const root = await makeTempDir()
    expect(await permissionsState(root)).toBe('missing')
  })

  it('reports missing when permissions.allow is absent', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({}))
    expect(await permissionsState(root)).toBe('missing')
  })

  it('reports empty when permissions.allow is an empty array', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }))
    expect(await permissionsState(root)).toBe('empty')
  })

  it('reports populated when permissions.allow is non-empty', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }))
    expect(await permissionsState(root)).toBe('populated')
  })
})

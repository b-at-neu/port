import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform'
import { pathOps } from '../platform'
import type { GitRunner } from './harness'
import { addRepository, listRepositories, removeRepository } from './index'
import { readRegistry } from './store'

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function makeRepo(root: string, repo = 'acme/widgets'): Promise<void> {
  await mkdir(join(root, '.claude'), { recursive: true })
  await writeFile(join(root, '.claude', 'port.config.json'), JSON.stringify({ repo }))
}

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

/** Every repository directory this suite creates is its own git root — the
 *  fake runner just echoes back whatever `cwd` it is asked about, so a
 *  subdirectory query resolves to the deepest repo root that contains it. */
const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: [] }

function fakeGit(roots: readonly string[]): GitRunner {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
      const containing = roots.filter((root) => pathOps.samePath(cwd, root) || pathOps.contains(root, cwd)).sort((a, b) => b.length - a.length)
      const root = containing[0]
      return Promise.resolve(root === undefined ? NOT_FOUND : ok(`${root}\n`))
    }
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return Promise.resolve(ok('dev\n'))
    if (args[0] === 'rev-list' || args[0] === 'branch') return Promise.resolve(ok(''))
    return Promise.resolve(NOT_FOUND)
  }
}

describe('addRepository', () => {
  it('cancel leaves the registry untouched', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const deps = { registryDir, git: fakeGit([]), chooseDirectory: () => Promise.resolve(null) }
    const result = await addRepository(deps)
    expect(result).toEqual({ ok: true, outcome: 'cancelled' })
    expect(await readRegistry(registryDir)).toEqual({ ok: true, repositories: [] })
  })

  it('adds a new repository', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const repoDir = await makeTempDir('port-registry-repo-')
    await makeRepo(repoDir)
    const deps = { registryDir, git: fakeGit([repoDir]), chooseDirectory: () => Promise.resolve(repoDir) }
    const result = await addRepository(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toBe('added')
    if (result.outcome !== 'added') throw new Error('unreachable')
    expect(result.repositories).toHaveLength(1)
    expect(result.repositories[0]?.id).toBe(result.added)
  })

  it('adding the same path again reports already-registered with one entry', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const repoDir = await makeTempDir('port-registry-repo-')
    await makeRepo(repoDir)
    const deps = { registryDir, git: fakeGit([repoDir]), chooseDirectory: () => Promise.resolve(repoDir) }
    await addRepository(deps)
    const second = await addRepository(deps)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.outcome).toBe('already-registered')
    if (second.outcome !== 'already-registered') throw new Error('unreachable')
    expect(second.repositories).toHaveLength(1)
  })

  it('adding a subdirectory of a registered repository reports already-registered', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const repoDir = await makeTempDir('port-registry-repo-')
    await makeRepo(repoDir)
    const subDir = join(repoDir, 'apps', 'desktop')
    await mkdir(subDir, { recursive: true })
    const deps = { registryDir, git: fakeGit([repoDir]), chooseDirectory: () => Promise.resolve(repoDir) }
    await addRepository(deps)
    const second = await addRepository({ ...deps, chooseDirectory: () => Promise.resolve(subDir) })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.outcome).toBe('already-registered')
    if (second.outcome !== 'already-registered') throw new Error('unreachable')
    expect(second.repositories).toHaveLength(1)
  })

  it('adding a directory that is not a repository still adds it, problem visible', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const notARepo = await makeTempDir('port-registry-not-a-repo-')
    const deps = { registryDir, git: fakeGit([]), chooseDirectory: () => Promise.resolve(notARepo) }
    const result = await addRepository(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toBe('added')
    if (result.outcome !== 'added') throw new Error('unreachable')
    expect(result.repositories).toHaveLength(1)
    const entry = result.repositories[0]
    expect(entry && 'problem' in entry && entry.problem.kind).toBe('not-a-git-repository')
  })
})

describe('removeRepository', () => {
  it('removes a registered repository by id', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const repoDir = await makeTempDir('port-registry-repo-')
    await makeRepo(repoDir)
    const deps = { registryDir, git: fakeGit([repoDir]), chooseDirectory: () => Promise.resolve(repoDir) }
    const added = await addRepository(deps)
    if (!added.ok || added.outcome !== 'added') throw new Error('unreachable')
    const result = await removeRepository(deps, added.added)
    expect(result).toEqual({ ok: true, repositories: [] })
  })

  it('reports not-registered for an unknown id, list unchanged', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const repoDir = await makeTempDir('port-registry-repo-')
    await makeRepo(repoDir)
    const deps = { registryDir, git: fakeGit([repoDir]), chooseDirectory: () => Promise.resolve(repoDir) }
    await addRepository(deps)
    const before = await listRepositories(deps)
    const result = await removeRepository(deps, 'not-a-real-id' as never)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-registered')
    const after = await listRepositories(deps)
    expect(after).toEqual(before)
  })
})

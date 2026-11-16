import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'
import type { GitRunner } from '@/types/platform'
import { REPOSITORY_LIST_TTL_MS, addRepository, listRepositories, removeRepository } from '@/main/registry/index'
import { readRegistry } from '@/main/registry/store'
import { makeTempDir } from '../../../fixtures/fs'

async function makeRepo(root: string, repo = 'acme/widgets'): Promise<void> {
  await mkdir(join(root, '.claude'), { recursive: true })
  await writeFile(join(root, '.claude', 'port.config.json'), JSON.stringify({ repo }))
}

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

/** The fake runner echoes back whatever `cwd` it is asked about, so a subdirectory query resolves to the deepest repo root that contains it. */
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

function countingGit(inner: GitRunner): { readonly git: GitRunner; readonly calls: () => number; readonly reset: () => void } {
  let count = 0
  return {
    git: (args, cwd) => {
      count++
      return inner(args, cwd)
    },
    calls: () => count,
    reset: () => {
      count = 0
    },
  }
}

async function registeredDeps(extra: { readonly now?: () => number; readonly wrap?: (git: GitRunner) => GitRunner } = {}) {
  const registryDir = await makeTempDir('port-registry-index-')
  const repoDir = await makeTempDir('port-registry-repo-')
  await makeRepo(repoDir)
  const counter = countingGit(fakeGit([repoDir]))
  const git = extra.wrap ? extra.wrap(counter.git) : counter.git
  const deps = { registryDir, git, chooseDirectory: () => Promise.resolve(repoDir), now: extra.now }
  const added = await addRepository(deps)
  if (!added.ok || added.outcome !== 'added') throw new Error('unreachable')
  return { deps, counter, registryDir, repoDir, added: added.added }
}

describe('listRepositories cache', () => {
  it('shares one inspection between concurrent callers', async () => {
    let clock = 0
    const { deps, counter } = await registeredDeps({ now: () => clock })
    clock += REPOSITORY_LIST_TTL_MS
    counter.reset()
    const single = await listRepositories({ ...deps }, { fresh: true })
    const perList = counter.calls()
    expect(perList).toBeGreaterThan(0)

    const other = { ...deps }
    counter.reset()
    const [a, b] = await Promise.all([listRepositories(other), listRepositories(other)])
    expect(counter.calls()).toBe(perList)
    expect(a).toBe(b)
    expect(a).toEqual(single)
  })

  it('reuses the result within the TTL and re-inspects after it', async () => {
    let clock = 0
    const { deps, counter } = await registeredDeps({ now: () => clock })
    clock += REPOSITORY_LIST_TTL_MS
    await listRepositories(deps)
    counter.reset()
    clock += REPOSITORY_LIST_TTL_MS - 1
    await listRepositories(deps)
    expect(counter.calls()).toBe(0)
    clock += 1
    await listRepositories(deps)
    expect(counter.calls()).toBeGreaterThan(0)
  })

  it('fresh re-inspects inside the TTL and a following non-fresh call reuses it', async () => {
    const { deps, counter } = await registeredDeps({ now: () => 0 })
    counter.reset()
    await listRepositories(deps, { fresh: true })
    expect(counter.calls()).toBeGreaterThan(0)
    counter.reset()
    await listRepositories(deps)
    expect(counter.calls()).toBe(0)
  })

  it('reflects an add and a remove immediately', async () => {
    const registryDir = await makeTempDir('port-registry-index-')
    const repoDir = await makeTempDir('port-registry-repo-')
    await makeRepo(repoDir)
    const deps = { registryDir, git: fakeGit([repoDir]), chooseDirectory: () => Promise.resolve(repoDir), now: () => 0 }
    const empty = await listRepositories(deps)
    expect(empty).toEqual({ ok: true, repositories: [] })

    const added = await addRepository(deps)
    if (!added.ok || added.outcome !== 'added') throw new Error('unreachable')
    const afterAdd = await listRepositories(deps)
    expect(afterAdd.ok && afterAdd.repositories.map((entry) => entry.id)).toEqual([added.added])

    await removeRepository(deps, added.added)
    expect(await listRepositories(deps)).toEqual({ ok: true, repositories: [] })
  })

  it('a list in flight during a remove never re-caches the removed repository', async () => {
    let release: () => void = () => undefined
    let gated = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, added } = await registeredDeps({
      now: () => 0,
      wrap: (git) => (args, cwd) => (gated ? gate.then(() => git(args, cwd)) : git(args, cwd)),
    })
    gated = true
    const stale = listRepositories(deps, { fresh: true })
    gated = false
    await removeRepository(deps, added)
    release()
    const staleResult = await stale
    expect(staleResult.ok && staleResult.repositories).toHaveLength(1)
    expect(await listRepositories(deps)).toEqual({ ok: true, repositories: [] })
  })

  it('does not cache a failed read', async () => {
    let clock = 0
    const { deps, registryDir } = await registeredDeps({ now: () => clock })
    await writeFile(join(registryDir, 'registry.json'), '{ not json')
    const failed = await listRepositories(deps, { fresh: true })
    expect(failed.ok).toBe(false)
    await writeFile(join(registryDir, 'registry.json'), JSON.stringify({ version: 1, repositories: [] }))
    clock += REPOSITORY_LIST_TTL_MS
    expect(await listRepositories(deps)).toEqual({ ok: true, repositories: [] })
  })

  it('never shares a cache between separate deps objects', async () => {
    const first = await registeredDeps({ now: () => 0 })
    const second = await registeredDeps({ now: () => 0 })
    await listRepositories(first.deps)
    second.counter.reset()
    await listRepositories(second.deps, { fresh: true })
    expect(second.counter.calls()).toBeGreaterThan(0)
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

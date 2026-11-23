import { describe, expect, it } from 'vitest'
import type { CommandResult, PlatformFs } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'
import type { GitRunner } from '@/types/platform'
import { REPOSITORY_LIST_TTL_MS, addRepository, createRepos, listRepositories, readyOf, removeRepository } from '@/main/repos/index'
import { readRegistry } from '@/main/repos/registry-store'
import type { ReposListResponse } from '@/types/ipc'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { createFakeFs, createFakePlatform } from '../../../support/fake-platform'
import { readyEntry } from '../../../support/repo-config'

const REGISTRY_DIR = '/registry'
const REPO_DIR = '/repos/widgets'
const SUB_DIR = '/repos/widgets/apps/desktop'
const PLAIN_DIR = '/repos/not-a-repo'

async function makeFs(): Promise<PlatformFs> {
  const fs = createFakeFs()
  for (const dir of [REGISTRY_DIR, REPO_DIR, SUB_DIR, PLAIN_DIR]) await fs.ensureDir(dir)
  return fs
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

type Pick = 'cancel' | 'repo' | 'subdirectory' | 'plain'

const ADD_CASES: readonly { readonly name: string; readonly picks: readonly Pick[]; readonly outcome: string; readonly registered: number; readonly problem?: string }[] = [
  { name: 'cancel leaves the registry untouched', picks: ['cancel'], outcome: 'cancelled', registered: 0 },
  { name: 'adds a new repository', picks: ['repo'], outcome: 'added', registered: 1 },
  { name: 'adding the same path again reports already-registered with one entry', picks: ['repo', 'repo'], outcome: 'already-registered', registered: 1 },
  { name: 'adding a subdirectory of a registered repository reports already-registered', picks: ['repo', 'subdirectory'], outcome: 'already-registered', registered: 1 },
  { name: 'a directory that is not a repository is still added, problem visible', picks: ['plain'], outcome: 'added', registered: 1, problem: 'not-a-git-repository' },
]

describe('addRepository', () => {
  it.each(ADD_CASES)('$name', async ({ picks, outcome, registered, problem }) => {
    const fs = await makeFs()
    const chosen: Record<Pick, string | null> = { cancel: null, repo: REPO_DIR, subdirectory: SUB_DIR, plain: PLAIN_DIR }

    let last: Awaited<ReturnType<typeof addRepository>> | undefined
    for (const pick of picks) last = await addRepository({ registryDir: REGISTRY_DIR, git: fakeGit([REPO_DIR]), fs, chooseDirectory: () => Promise.resolve(chosen[pick]) })

    expect(last?.ok && last.outcome).toBe(outcome)
    const stored = await readRegistry({ fs }, REGISTRY_DIR)
    expect(stored.ok && stored.repositories).toHaveLength(registered)
    if (problem !== undefined) {
      const entry = last?.ok && last.outcome === 'added' ? last.repositories[0] : undefined
      expect(entry && 'problem' in entry && entry.problem.kind).toBe(problem)
    }
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
  const fs = await makeFs()
  const counter = countingGit(fakeGit([REPO_DIR]))
  const git = extra.wrap ? extra.wrap(counter.git) : counter.git
  const deps = { registryDir: REGISTRY_DIR, git, fs, chooseDirectory: () => Promise.resolve(REPO_DIR), now: extra.now }
  const added = await addRepository(deps)
  if (!added.ok || added.outcome !== 'added') throw new Error('unreachable')
  return { deps, counter, fs, added: added.added }
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
    const fs = await makeFs()
    const deps = { registryDir: REGISTRY_DIR, git: fakeGit([REPO_DIR]), fs, chooseDirectory: () => Promise.resolve(REPO_DIR), now: () => 0 }
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
    const { deps, fs } = await registeredDeps({ now: () => clock })
    await fs.writeText(`${REGISTRY_DIR}/registry.json`, '{ not json')
    const failed = await listRepositories(deps, { fresh: true })
    expect(failed.ok).toBe(false)
    await fs.writeText(`${REGISTRY_DIR}/registry.json`, JSON.stringify({ version: 1, repositories: [] }))
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
  it.each([
    { name: 'removes a registered repository by id', known: true },
    { name: 'reports not-registered for an unknown id, list unchanged', known: false },
  ])('$name', async ({ known }) => {
    const { deps, added } = await registeredDeps({ now: () => 0 })
    const before = await listRepositories(deps)
    const result = await removeRepository(deps, known ? added : ('not-a-real-id' as RepoId))
    if (known) {
      expect(result).toEqual({ ok: true, repositories: [] })
      return
    }
    expect(result.ok === false && result.kind).toBe('not-registered')
    expect(await listRepositories(deps)).toEqual(before)
  })
})

describe('readyOf', () => {
  const ready = readyEntry()
  const broken: RepositoryEntry = { id: 'broken' as RepoId, path: '/broken', displayName: 'broken', problem: { kind: 'not-a-git-repository' }, diagnostics: [] }
  const list: ReposListResponse = { ok: true, repositories: [ready, broken] }

  it.each([
    { name: 'a ready repository resolves to its entry', list, id: ready.id, expected: { ok: true, entry: ready } },
    { name: 'an unknown id is not-registered', list, id: 'nope' as RepoId, expected: { ok: false, kind: 'not-registered', message: "no repository is registered with id 'nope'" } },
    { name: 'a problem entry is not-ready', list, id: broken.id, expected: { ok: false, kind: 'not-ready', message: "repository 'broken' is 'not-a-git-repository', not ready" } },
    { name: 'an unlistable registry carries its own message', list: { ok: false, kind: 'registry-unreadable', message: 'disk on fire' } as ReposListResponse, id: ready.id, expected: { ok: false, kind: 'unlistable', message: 'disk on fire' } },
  ])('$name', ({ list: given, id, expected }) => {
    expect(readyOf(given, id)).toEqual(expected)
  })
})

describe('createRepos', () => {
  it('shares one cache between the service and the legacy deps handle', async () => {
    const counter = countingGit(fakeGit([REPO_DIR]))
    const platform = createFakePlatform()
    await platform.fs.ensureDir(REPO_DIR)
    const repos = createRepos({
      paths: { ...platform.paths, userData: REGISTRY_DIR },
      git: counter.git,
      fs: platform.fs,
      dialogs: { ...platform.dialogs, chooseDirectory: () => Promise.resolve(REPO_DIR) },
      clock: platform.clock,
    })
    const added = await repos.add()
    expect(added.ok && added.outcome).toBe('added')
    counter.reset()
    await listRepositories(repos.deps)
    expect(counter.calls()).toBe(0)
  })
})

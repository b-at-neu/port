import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'
import type { GitRunner } from '@/types/platform'
import { REPOSITORY_LIST_TTL_MS, createRepos, readyOf } from '@/main/repos/index'
import { readRegistry } from '@/main/repos/registry-store'
import type { ReposListResponse } from '@/types/ipc'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { createFakePlatform } from '../../../support/fake-platform'
import { readyEntry } from '../../../support/repo-config'

const REGISTRY_DIR = pathOps.toNative('/registry')
const REPO_DIR = pathOps.toNative('/repos/widgets')
const SUB_DIR = pathOps.join(REPO_DIR, 'apps', 'desktop')
const PLAIN_DIR = pathOps.toNative('/repos/not-a-repo')
const REGISTRY_FILE = pathOps.join(REGISTRY_DIR, 'registry.json')

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NOT_FOUND: CommandResult = { ok: false, kind: 'not-found', command: 'git', searched: [] }

/** The fake runner echoes back whatever `cwd` it is asked about, so a subdirectory query resolves to the deepest repo root that contains it. */
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

const PICKED: Record<Pick, string | null> = { cancel: null, repo: REPO_DIR, subdirectory: SUB_DIR, plain: PLAIN_DIR }

/** A registry service over fakes whose git calls are counted and whose directory picker answers `pick`. */
async function rig(options: { readonly wrap?: (git: GitRunner) => GitRunner } = {}) {
  const platform = createFakePlatform()
  for (const dir of [REGISTRY_DIR, REPO_DIR, SUB_DIR, PLAIN_DIR]) await platform.fs.ensureDir(dir)
  let count = 0
  const inner = fakeGit([REPO_DIR])
  const counted: GitRunner = (args, cwd) => {
    count++
    return inner(args, cwd)
  }
  const state = { pick: 'repo' as Pick }
  const repos = createRepos({
    paths: { ...platform.paths, userData: REGISTRY_DIR },
    git: options.wrap ? options.wrap(counted) : counted,
    fs: platform.fs,
    dialogs: { ...platform.dialogs, chooseDirectory: () => Promise.resolve(PICKED[state.pick]) },
    clock: platform.clock,
  })
  return {
    repos,
    fs: platform.fs,
    clock: platform.clock,
    pick: (next: Pick) => {
      state.pick = next
    },
    calls: () => count,
    reset: () => {
      count = 0
    },
  }
}

async function registered(options?: Parameters<typeof rig>[0]) {
  const world = await rig(options)
  const added = await world.repos.add()
  if (!added.ok || added.outcome !== 'added') throw new Error('unreachable')
  return { ...world, added: added.added }
}

const ADD_CASES: readonly { readonly name: string; readonly picks: readonly Pick[]; readonly outcome: string; readonly registered: number; readonly problem?: string }[] = [
  { name: 'cancel leaves the registry untouched', picks: ['cancel'], outcome: 'cancelled', registered: 0 },
  { name: 'adds a new repository', picks: ['repo'], outcome: 'added', registered: 1 },
  { name: 'adding the same path again reports already-registered with one entry', picks: ['repo', 'repo'], outcome: 'already-registered', registered: 1 },
  { name: 'adding a subdirectory of a registered repository reports already-registered', picks: ['repo', 'subdirectory'], outcome: 'already-registered', registered: 1 },
  { name: 'a directory that is not a repository is still added, problem visible', picks: ['plain'], outcome: 'added', registered: 1, problem: 'not-a-git-repository' },
]

describe('repos.add', () => {
  it.each(ADD_CASES)('$name', async ({ picks, outcome, registered: count, problem }) => {
    const world = await rig()

    let last: Awaited<ReturnType<typeof world.repos.add>> | undefined
    for (const pick of picks) {
      world.pick(pick)
      last = await world.repos.add()
    }

    expect(last?.ok && last.outcome).toBe(outcome)
    const stored = await readRegistry({ fs: world.fs }, REGISTRY_DIR)
    expect(stored.ok && stored.repositories).toHaveLength(count)
    if (problem !== undefined) {
      const entry = last?.ok && last.outcome === 'added' ? last.repositories[0] : undefined
      expect(entry && 'problem' in entry && entry.problem.kind).toBe(problem)
    }
  })
})

describe('repos.list cache', () => {
  it('shares one inspection between concurrent callers', async () => {
    const { repos, clock, calls, reset } = await registered()
    clock.advance(REPOSITORY_LIST_TTL_MS)
    reset()
    const single = await repos.list({ fresh: true })
    const perList = calls()
    expect(perList).toBeGreaterThan(0)

    clock.advance(REPOSITORY_LIST_TTL_MS)
    reset()
    const [a, b] = await Promise.all([repos.list(), repos.list()])
    expect(calls()).toBe(perList)
    expect(a).toBe(b)
    expect(a).toEqual(single)
  })

  it('reuses the result within the TTL and re-inspects after it', async () => {
    const { repos, clock, calls, reset } = await registered()
    clock.advance(REPOSITORY_LIST_TTL_MS)
    await repos.list()
    reset()
    clock.advance(REPOSITORY_LIST_TTL_MS - 1)
    await repos.list()
    expect(calls()).toBe(0)
    clock.advance(1)
    await repos.list()
    expect(calls()).toBeGreaterThan(0)
  })

  it('fresh re-inspects inside the TTL and a following non-fresh call reuses it', async () => {
    const { repos, calls, reset } = await registered()
    reset()
    await repos.list({ fresh: true })
    expect(calls()).toBeGreaterThan(0)
    reset()
    await repos.list()
    expect(calls()).toBe(0)
  })

  it('reflects an add and a remove immediately', async () => {
    const world = await rig()
    expect(await world.repos.list()).toEqual({ ok: true, repositories: [] })

    const added = await world.repos.add()
    if (!added.ok || added.outcome !== 'added') throw new Error('unreachable')
    const afterAdd = await world.repos.list()
    expect(afterAdd.ok && afterAdd.repositories.map((entry) => entry.id)).toEqual([added.added])

    await world.repos.remove(added.added)
    expect(await world.repos.list()).toEqual({ ok: true, repositories: [] })
  })

  it('a list in flight during a remove never re-caches the removed repository', async () => {
    let release: () => void = () => undefined
    let gated = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { repos, added } = await registered({ wrap: (git) => (args, cwd) => (gated ? gate.then(() => git(args, cwd)) : git(args, cwd)) })
    gated = true
    const stale = repos.list({ fresh: true })
    gated = false
    await repos.remove(added)
    release()
    const staleResult = await stale
    expect(staleResult.ok && staleResult.repositories).toHaveLength(1)
    expect(await repos.list()).toEqual({ ok: true, repositories: [] })
  })

  it('does not cache a failed read', async () => {
    const { repos, fs, clock } = await registered()
    await fs.writeText(REGISTRY_FILE, '{ not json')
    const failed = await repos.list({ fresh: true })
    expect(failed.ok).toBe(false)
    await fs.writeText(REGISTRY_FILE, JSON.stringify({ version: 1, repositories: [] }))
    clock.advance(REPOSITORY_LIST_TTL_MS)
    expect(await repos.list()).toEqual({ ok: true, repositories: [] })
  })
})

describe('repos.remove', () => {
  it.each([
    { name: 'removes a registered repository by id', known: true },
    { name: 'reports not-registered for an unknown id, list unchanged', known: false },
  ])('$name', async ({ known }) => {
    const { repos, added } = await registered()
    const before = await repos.list()
    const result = await repos.remove(known ? added : ('not-a-real-id' as RepoId))
    if (known) {
      expect(result).toEqual({ ok: true, repositories: [] })
      return
    }
    expect(result.ok === false && result.kind).toBe('not-registered')
    expect(await repos.list()).toEqual(before)
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

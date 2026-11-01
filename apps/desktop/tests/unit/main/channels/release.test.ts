import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReposListResponse } from '@/types/ipc'
import type { RegistryDeps } from '@/types/registry'
import type { ReleasePhase, ReleaseRead, ReleaseStatus } from '@/types/release'

import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { resolveReleaseRun, resolveReleaseStatus } from '@/main/channels/release'
import type { ReleaseChannelDeps } from '@/main/channels/release'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'acme/widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: resolveVocabulary({}),
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: [],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

function status(phase: ReleasePhase, overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return { phase, versionSource: 'package', production: 'main', integration: 'dev', currentVersion: '0.2.0', candidates: [], entries: [{ number: 12, title: 'Add dark mode', labels: [], dependency: false }], truncatedNote: null, releases: [], productionHead: 'prod-oid', postPublishHook: 'node scripts/dev-window.ts', readAt: 't', ...overrides }
}

interface Calls {
  readonly names: string[]
  readonly seen: Record<string, unknown>
}

function depsFor(read: ReleaseRead, calls: Calls, overrides: Partial<ReleaseChannelDeps> = {}): ReleaseChannelDeps {
  const record = (name: string, value: unknown = null) => {
    calls.names.push(name)
    calls.seen[name] = value
  }
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] } as ReposListResponse),
    readConfig: () => Promise.resolve({ ok: true, config: { versionSource: 'package', versionFiles: ['package.json'], versionCommand: null, postPublishHook: 'node scripts/dev-window.ts' } }),
    fetchStatus: () => Promise.resolve(read),
    readFile: () => Promise.resolve({ ok: true, text: JSON.stringify({ name: 'x', version: '0.2.1-dev' }) }),
    createBumpBranch: (_ctx, params) => {
      record('bump', params)
      return Promise.resolve({ ok: true, stdout: '' })
    },
    openBumpPr: () => {
      record('bump-pr')
      return Promise.resolve({ ok: true, stdout: '' })
    },
    openReleasePr: (_ctx, params) => {
      record('release-pr', params)
      return Promise.resolve({ ok: true, stdout: '' })
    },
    publishRelease: (_ctx, params) => {
      record('publish', params)
      return Promise.resolve({ ok: true, stdout: 'https://github.com/acme/widgets/releases/tag/v0.3.0\n' })
    },
    runHook: () => Promise.resolve({ kind: 'ok', stdout: 'done' }),
    recordHook: () => {
      record('hook-audit')
      return Promise.resolve({ ok: true, stdout: '' })
    },
    now: () => new Date('2026-09-05T14:00:00.000Z'),
    ...overrides,
  }
}

const HEAD = { oid: 'int-oid', tree: 'int-tree' }
function readOf(phase: ReleasePhase, overrides: Partial<ReleaseStatus> = {}): ReleaseRead {
  return { ok: true, status: status(phase, overrides), integrationHead: HEAD, viewer: 'octo-operator' }
}
function newCalls(): Calls {
  return { names: [], seen: {} }
}

function run(read: ReleaseRead, request: Parameters<typeof resolveReleaseRun>[1], calls: Calls, overrides: Partial<ReleaseChannelDeps> = {}) {
  return resolveReleaseRun(registryDeps, request, '/audit', '/tmp', depsFor(read, calls, overrides))
}

describe('resolveReleaseStatus', () => {
  it('rejects a missing repoId and a repository that is not ready', async () => {
    const deps = depsFor(readOf({ kind: 'idle' }), newCalls())
    await expect(resolveReleaseStatus(registryDeps, { repoId: undefined as unknown as RepoId }, deps)).rejects.toThrow("'release:status' requires a non-empty 'repoId'")
    const notReady = { ...deps, listRepositories: () => Promise.resolve({ ok: true, repositories: [{ id: REPO_ID, path: '/repo', displayName: 'w', problem: { kind: 'directory-missing' as const }, diagnostics: [] }] } as ReposListResponse) }
    await expect(resolveReleaseStatus(registryDeps, { repoId: REPO_ID }, notReady)).rejects.toThrow("requires a 'ready' repository")
  })

  it('returns the status without the integration head, and a read failure as data', async () => {
    const calls = newCalls()
    expect(await resolveReleaseStatus(registryDeps, { repoId: REPO_ID }, depsFor(readOf({ kind: 'idle' }), calls))).toEqual({ ok: true, status: status({ kind: 'idle' }) })
    const failed: ReleaseRead = { ok: false, message: 'gh is signed out', readAt: 't' }
    expect(await resolveReleaseStatus(registryDeps, { repoId: REPO_ID }, depsFor(failed, calls))).toEqual(failed)
  })

  it('fails the read, offering no action, when the config is unreadable', async () => {
    const deps = depsFor(readOf({ kind: 'idle' }), newCalls(), { readConfig: () => Promise.resolve({ ok: false, message: 'no config' }) })
    expect(await resolveReleaseStatus(registryDeps, { repoId: REPO_ID }, deps)).toMatchObject({ ok: false, message: 'no config' })
  })
})

describe('resolveReleaseRun validation', () => {
  it('throws on a bad step or oversized or blank notes', async () => {
    await expect(run(readOf({ kind: 'idle' }), { repoId: REPO_ID, step: 'merge' as 'open', version: '0.3.0' }, newCalls())).rejects.toThrow("'release:run' step must be 'open' or 'publish'")
    await expect(run(readOf({ kind: 'ready-to-publish', version: '0.3.0' }), { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: '  \n' }, newCalls())).rejects.toThrow('notes of 1 to 125000 characters')
    await expect(run(readOf({ kind: 'ready-to-publish', version: '0.3.0' }), { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'x'.repeat(125_001) }, newCalls())).rejects.toThrow('notes of 1 to 125000')
  })

  it('refuses an unparseable version before reading anything', async () => {
    const calls = newCalls()
    const result = await run(readOf({ kind: 'idle' }), { repoId: REPO_ID, step: 'open', version: '1.5' }, calls, { listRepositories: () => Promise.reject(new Error('must not list')) })
    expect(result).toMatchObject({ kind: 'refused', reason: 'invalid-version' })
  })
})

describe('resolveReleaseRun open', () => {
  it('bumps, opens both pull requests in order and re-serializes the version files', async () => {
    const calls = newCalls()
    const result = await run(readOf({ kind: 'idle' }), { repoId: REPO_ID, step: 'open', version: 'v0.3.0' }, calls)
    expect(result).toEqual({ kind: 'opened' })
    expect(calls.names).toEqual(['bump', 'bump-pr', 'release-pr'])
    expect(calls.seen['bump']).toEqual({ head: HEAD, files: [{ path: 'package.json', content: '{\n  "name": "x",\n  "version": "0.3.0"\n}\n' }] })
    expect(calls.seen['release-pr']).toMatchObject({ production: 'main', integration: 'dev', assignee: 'octo-operator' })
    expect((calls.seen['release-pr'] as { body: string }).body).toContain('## Release v0.3.0')
  })

  it('skips the bump for tags', async () => {
    const calls = newCalls()
    const result = await run(readOf({ kind: 'idle' }, { versionSource: 'tags' }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, calls, {
      readConfig: () => Promise.resolve({ ok: true, config: { versionSource: 'tags', versionFiles: [], versionCommand: null, postPublishHook: null } }),
    })
    expect(result).toEqual({ kind: 'opened' })
    expect(calls.names).toEqual(['release-pr'])
  })

  it('only opens the release pull request when dev already carries the bump', async () => {
    const calls = newCalls()
    await run(readOf({ kind: 'bumped', version: '0.3.0' }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, calls)
    expect(calls.names).toEqual(['release-pr'])
  })

  it('resumes from the missing pull requests while waiting on the bump', async () => {
    const calls = newCalls()
    await run(readOf({ kind: 'waiting-bump', version: '0.3.0', bumpPr: null, releasePr: null }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, calls)
    expect(calls.names).toEqual(['bump-pr', 'release-pr'])
    const done = newCalls()
    await run(readOf({ kind: 'waiting-bump', version: '0.3.0', bumpPr: { number: 1, url: 'u' }, releasePr: { number: 2, url: 'u' } }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, done)
    expect(done.names).toEqual([])
  })

  it('refuses a stale screen: another phase, another version, an existing tag', async () => {
    const waiting = readOf({ kind: 'waiting-merge', version: '0.3.0', releasePr: { number: 612, url: 'u' } })
    expect(await run(waiting, { repoId: REPO_ID, step: 'open', version: '0.3.0' }, newCalls())).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    expect(await run(readOf({ kind: 'bumped', version: '0.3.0' }), { repoId: REPO_ID, step: 'open', version: '0.4.0' }, newCalls())).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    const tagged = readOf({ kind: 'idle' }, { releases: [{ tagName: 'v0.3.0', name: 'v0.3.0', url: 'u', publishedAt: null, isPrerelease: false, isLatest: false, description: '' }] })
    expect(await run(tagged, { repoId: REPO_ID, step: 'open', version: '0.3.0' }, newCalls())).toMatchObject({ kind: 'refused', reason: 'tag-exists' })
  })

  it('refuses an unsupported repository and a version file it cannot bump', async () => {
    expect(await run(readOf({ kind: 'needs-terminal' }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, newCalls())).toMatchObject({ kind: 'refused', reason: 'unsupported' })
    const calls = newCalls()
    const result = await run(readOf({ kind: 'idle' }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, calls, { readFile: () => Promise.resolve({ ok: true, text: 'version = "0.2.0"' }) })
    expect(result).toMatchObject({ kind: 'refused', reason: 'unsupported' })
    expect(calls.names).toEqual([])
  })

  it('reports the failing step and writes nothing after it', async () => {
    const calls = newCalls()
    const result = await run(readOf({ kind: 'idle' }), { repoId: REPO_ID, step: 'open', version: '0.3.0' }, calls, { openBumpPr: () => Promise.resolve({ ok: false, stderr: 'rate limited' }) })
    expect(result).toEqual({ kind: 'failed', step: 'bump-pr', stderr: 'rate limited' })
    expect(calls.names).toEqual(['bump'])
  })

  it('refuses rather than writing when the state cannot be re-read', async () => {
    const calls = newCalls()
    const result = await run({ ok: false, message: 'offline', readAt: 't' }, { repoId: REPO_ID, step: 'open', version: '0.3.0' }, calls)
    expect(result).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    expect(calls.names).toEqual([])
  })
})

describe('resolveReleaseRun publish', () => {
  const ready = readOf({ kind: 'ready-to-publish', version: '0.3.0' })

  it('publishes at the production head, then runs and audits the hook', async () => {
    const calls = newCalls()
    const result = await run(ready, { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: '- A thing\n' }, calls)
    expect(result).toEqual({ kind: 'published', url: 'https://github.com/acme/widgets/releases/tag/v0.3.0', hook: { kind: 'ok', stdout: 'done' } })
    expect(calls.seen['publish']).toEqual({ target: 'prod-oid', notes: '- A thing\n' })
    expect(calls.names).toEqual(['publish', 'hook-audit'])
  })

  it('never undoes a publish when the hook fails', async () => {
    const calls = newCalls()
    const result = await run(ready, { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'n' }, calls, { runHook: () => Promise.resolve({ kind: 'failed', exitCode: 1, stderr: 'dirty' }) })
    expect(result).toMatchObject({ kind: 'published', hook: { kind: 'failed', exitCode: 1 } })
  })

  it('does not audit a skipped hook', async () => {
    const calls = newCalls()
    await run(ready, { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'n' }, calls, { runHook: () => Promise.resolve({ kind: 'skipped' }) })
    expect(calls.names).toEqual(['publish'])
  })

  it('refuses early publishing and a different version', async () => {
    const early = readOf({ kind: 'waiting-merge', version: '0.3.0', releasePr: { number: 612, url: 'u' } })
    expect(await run(early, { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'n' }, newCalls())).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    expect(await run(ready, { repoId: REPO_ID, step: 'publish', version: '0.4.0', notes: 'n' }, newCalls())).toMatchObject({ kind: 'refused', reason: 'state-changed' })
  })

  it('reports a failed release creation without running the hook', async () => {
    const calls = newCalls()
    const result = await run(ready, { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'n' }, calls, { publishRelease: () => Promise.resolve({ ok: false, stderr: 'tag exists' }) })
    expect(result).toEqual({ kind: 'failed', step: 'publish', stderr: 'tag exists' })
    expect(calls.names).toEqual([])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { HookOutcome, ReleaseConfigRead, ReleasePhase, ReleaseRead, ReleaseStatus, ReleaseWriteResult } from '@/types/release'
import { fetchReleaseStatus, readFileAtRef } from '@/main/github/release'
import { fetchReleaseIssues } from '@/main/github/release-issues'
import { createBumpBranch, openBumpPr, openReleasePr, publishRelease, recordHook } from '@/main/github/writes/release'
import { readReleaseConfig } from '@/main/features/release/config'
import { runPostPublishHook } from '@/main/features/release/hook'
import { callAction, createTestContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'

vi.mock('@/main/github/release', () => ({ fetchReleaseStatus: vi.fn(), readFileAtRef: vi.fn() }))
vi.mock('@/main/github/release-issues', () => ({ fetchReleaseIssues: vi.fn() }))
vi.mock('@/main/github/writes/release', () => ({ createBumpBranch: vi.fn(), openBumpPr: vi.fn(), openReleasePr: vi.fn(), publishRelease: vi.fn(), recordHook: vi.fn() }))
vi.mock('@/main/features/release/config', () => ({ readReleaseConfig: vi.fn() }))
vi.mock('@/main/features/release/hook', () => ({ runPostPublishHook: vi.fn() }))

const REPO_ID = 'repo-1' as unknown as RepoId
const READY_ENTRY = readyEntry({ id: REPO_ID, path: '/repo' }, { repo: 'acme/widgets', owner: 'acme', name: 'widgets' })
const NOT_READY: RepositoryEntry = { id: REPO_ID, path: '/repo', displayName: 'w', problem: { kind: 'directory-missing' }, diagnostics: [] }

const mocks = {
  status: vi.mocked(fetchReleaseStatus),
  file: vi.mocked(readFileAtRef),
  issues: vi.mocked(fetchReleaseIssues),
  config: vi.mocked(readReleaseConfig),
  hook: vi.mocked(runPostPublishHook),
  bump: vi.mocked(createBumpBranch),
  bumpPr: vi.mocked(openBumpPr),
  releasePr: vi.mocked(openReleasePr),
  publish: vi.mocked(publishRelease),
  record: vi.mocked(recordHook),
}

function status(phase: ReleasePhase, overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return { phase, versionSource: 'package', production: 'main', integration: 'dev', currentVersion: '0.2.0', sinceTag: 'v0.2.0', entries: [{ number: 12, title: 'Add dark mode', url: 'https://github.com/acme/widgets/pull/12', labels: [], mergedAt: '2026-08-02T00:00:00Z', dependency: false }], truncatedNote: null, releases: [], productionHead: 'prod-oid', postPublishHook: 'node scripts/dev-window.ts', readAt: 't', ...overrides }
}

const HEAD = { oid: 'int-oid', tree: 'int-tree' }
function readOf(phase: ReleasePhase, overrides: Partial<ReleaseStatus> = {}): ReleaseRead {
  return { ok: true, status: status(phase, overrides), integrationHead: HEAD, viewer: 'octo-operator' }
}

const PACKAGE_CONFIG: ReleaseConfigRead = { ok: true, config: { versionSource: 'package', versionFiles: ['package.json'], versionCommand: null, postPublishHook: 'node scripts/dev-window.ts' } }
const WRITE_OK: ReleaseWriteResult = { ok: true, stdout: '' }

interface Calls {
  readonly names: string[]
  readonly seen: Record<string, unknown>
}

/** Scripts every collaborator to succeed, recording the order of the writes; a test then overrides the one it cares about. */
function arrange(read: ReleaseRead): Calls {
  const calls: Calls = { names: [], seen: {} }
  const record = (name: string, value: unknown = null) => {
    calls.names.push(name)
    calls.seen[name] = value
  }
  mocks.config.mockResolvedValue(PACKAGE_CONFIG)
  mocks.status.mockResolvedValue(read)
  mocks.issues.mockResolvedValue({ ok: true, issues: [], note: null })
  mocks.file.mockResolvedValue({ ok: true, text: JSON.stringify({ name: 'x', version: '0.2.1-dev' }) })
  mocks.bump.mockImplementation((_ctx, write, params) => {
    record('bump', { ...params, root: write.root })
    return Promise.resolve(WRITE_OK)
  })
  mocks.bumpPr.mockImplementation(() => {
    record('bump-pr')
    return Promise.resolve(WRITE_OK)
  })
  mocks.releasePr.mockImplementation((_ctx, _write, params) => {
    record('release-pr', params)
    return Promise.resolve(WRITE_OK)
  })
  mocks.publish.mockImplementation((_ctx, _write, params) => {
    record('publish', params)
    return Promise.resolve({ ok: true, stdout: 'https://github.com/acme/widgets/releases/tag/v0.3.0\n' })
  })
  mocks.hook.mockResolvedValue({ kind: 'ok', stdout: 'done' })
  mocks.record.mockImplementation(() => {
    record('hook-audit')
    return Promise.resolve(WRITE_OK)
  })
  return calls
}

const ctxWith = (repositories: readonly RepositoryEntry[] = [READY_ENTRY]) => createTestContext({ repositories })

type RunRequest = Parameters<typeof callAction<'release.run'>>[2]
const run = (request: RunRequest, ctx = ctxWith()) => callAction(ctx, 'release.run', request)

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('release.status', () => {
  it('rejects a repository that is not ready', async () => {
    arrange(readOf({ kind: 'idle' }))
    await expect(callAction(ctxWith([NOT_READY]), 'release.status', { repoId: REPO_ID })).rejects.toThrow("requires a 'ready' repository")
  })

  it('returns the status without the integration head, and a read failure as data', async () => {
    arrange(readOf({ kind: 'idle' }))
    expect(await callAction(ctxWith(), 'release.status', { repoId: REPO_ID })).toEqual({ ok: true, status: status({ kind: 'idle' }) })
    const failed: ReleaseRead = { ok: false, message: 'gh is signed out', readAt: 't' }
    mocks.status.mockResolvedValue(failed)
    expect(await callAction(ctxWith(), 'release.status', { repoId: REPO_ID })).toEqual(failed)
  })

  it('fails the read, offering no action, when the config is unreadable', async () => {
    arrange(readOf({ kind: 'idle' }))
    mocks.config.mockResolvedValue({ ok: false, message: 'no config' })
    expect(await callAction(ctxWith(), 'release.status', { repoId: REPO_ID })).toMatchObject({ ok: false, message: 'no config' })
  })
})

describe('release.issues', () => {
  const issues = { ok: true as const, issues: [{ number: 12, title: 'Add dark mode', url: 'https://github.com/acme/widgets/issues/12', labels: [] }], note: null }
  const good = { repoId: REPO_ID, tag: 'v0.2.0', previousTag: 'v0.1.0' }

  it.each([
    ['a malformed tag', { ...good, tag: 'v1 --upload' }],
    ['a non-string tag', { ...good, tag: 5 }],
    ['a malformed previousTag', { ...good, previousTag: '../x?y' }],
    ['a missing previousTag', { ...good, previousTag: undefined }],
  ])('rejects %s', async (_label, request) => {
    await expect(callAction(ctxWith(), 'release.issues', request as never)).rejects.toThrow()
    expect(mocks.issues).not.toHaveBeenCalled()
  })

  it('rejects a repository that is not ready', async () => {
    await expect(callAction(ctxWith([NOT_READY]), 'release.issues', good)).rejects.toThrow("requires a 'ready' repository")
  })

  it("reads only the registered repository's own tags, and passes the response through", async () => {
    mocks.issues.mockResolvedValue(issues)
    expect(await callAction(ctxWith(), 'release.issues', { repoId: REPO_ID, tag: 'v0.2.0', previousTag: null })).toEqual(issues)
    expect(mocks.issues.mock.calls[0]?.[1]).toEqual({ repo: { owner: 'acme', name: 'widgets' }, tag: 'v0.2.0', previousTag: null })
  })
})

describe('release.run validation', () => {
  it.each([
    ['a bad step', { repoId: REPO_ID, step: 'merge', version: '0.3.0' }],
    ['blank notes', { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: '  \n' }],
    ['oversized notes', { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'x'.repeat(125_001) }],
  ])('throws on %s', async (_label, request) => {
    arrange(readOf({ kind: 'idle' }))
    await expect(run(request as never)).rejects.toThrow()
  })

  it('refuses an unparseable version before reading anything', async () => {
    arrange(readOf({ kind: 'idle' }))
    const ctx = createTestContext({ repos: { list: () => Promise.reject(new Error('must not list')) } })
    expect(await run({ repoId: REPO_ID, step: 'open', version: '1.5' }, ctx)).toMatchObject({ kind: 'refused', reason: 'invalid-version' })
  })
})

describe('release.run open', () => {
  it('bumps, opens both pull requests and re-serializes the version files', async () => {
    const calls = arrange(readOf({ kind: 'idle' }))
    expect(await run({ repoId: REPO_ID, step: 'open', version: 'v0.3.0' })).toEqual({ kind: 'opened' })
    expect([...calls.names].sort()).toEqual(['bump', 'bump-pr', 'release-pr'])
    expect(calls.seen['bump']).toEqual({ head: HEAD, files: [{ path: 'package.json', content: '{\n  "name": "x",\n  "version": "0.3.0"\n}\n' }], integration: 'dev', root: '/repo' })
    expect(calls.seen['release-pr']).toMatchObject({ production: 'main', integration: 'dev', assignee: 'octo-operator' })
    expect((calls.seen['release-pr'] as { body: string }).body).toContain('## Release v0.3.0')
  })

  it('skips the bump for tags', async () => {
    const calls = arrange(readOf({ kind: 'idle' }, { versionSource: 'tags' }))
    mocks.config.mockResolvedValue({ ok: true, config: { versionSource: 'tags', versionFiles: [], versionCommand: null, postPublishHook: null } })
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toEqual({ kind: 'opened' })
    expect(calls.names).toEqual(['release-pr'])
  })

  it('only opens the release pull request when dev already carries the bump', async () => {
    const calls = arrange(readOf({ kind: 'bumped', version: '0.3.0' }))
    await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })
    expect(calls.names).toEqual(['release-pr'])
  })

  it('resumes from the missing pull requests while waiting on the bump', async () => {
    const calls = arrange(readOf({ kind: 'waiting-bump', version: '0.3.0', bumpPr: null, releasePr: null }))
    await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })
    expect([...calls.names].sort()).toEqual(['bump-pr', 'release-pr'])
    const done = arrange(readOf({ kind: 'waiting-bump', version: '0.3.0', bumpPr: { number: 1, url: 'u' }, releasePr: { number: 2, url: 'u' } }))
    await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })
    expect(done.names).toEqual([])
  })

  it('refuses a stale screen: another phase, another version, an existing tag', async () => {
    arrange(readOf({ kind: 'waiting-merge', version: '0.3.0', releasePr: { number: 612, url: 'u' } }))
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    arrange(readOf({ kind: 'bumped', version: '0.3.0' }))
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.4.0' })).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    arrange(readOf({ kind: 'idle' }, { releases: [{ tagName: 'v0.3.0', name: 'v0.3.0', url: 'u', publishedAt: null, isPrerelease: false, isLatest: false, description: '', previousTag: null }] }))
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toMatchObject({ kind: 'refused', reason: 'tag-exists' })
  })

  it('refuses an unsupported repository and a version file it cannot bump', async () => {
    arrange(readOf({ kind: 'needs-terminal' }))
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toMatchObject({ kind: 'refused', reason: 'unsupported' })
    const calls = arrange(readOf({ kind: 'idle' }))
    mocks.file.mockResolvedValue({ ok: true, text: 'version = "0.2.0"' })
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toMatchObject({ kind: 'refused', reason: 'unsupported' })
    expect(calls.names).toEqual([])
  })

  it('reports the failing step and writes nothing after it', async () => {
    const calls = arrange(readOf({ kind: 'idle' }))
    mocks.bumpPr.mockResolvedValue({ ok: false, stderr: 'rate limited' })
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toEqual({ kind: 'failed', step: 'bump-pr', stderr: 'rate limited' })
    expect(calls.names).toEqual(['bump'])
  })

  it('refuses rather than writing when the state cannot be re-read', async () => {
    const calls = arrange({ ok: false, message: 'offline', readAt: 't' })
    expect(await run({ repoId: REPO_ID, step: 'open', version: '0.3.0' })).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    expect(calls.names).toEqual([])
  })
})

describe('release.run publish', () => {
  const ready = () => readOf({ kind: 'ready-to-publish', version: '0.3.0' })
  const publishRequest = { repoId: REPO_ID, step: 'publish', version: '0.3.0', notes: 'n' } as const

  it('publishes at the production head, then runs and audits the hook', async () => {
    const calls = arrange(ready())
    const result = await run({ ...publishRequest, notes: '- A thing\n' })
    expect(result).toEqual({ kind: 'published', url: 'https://github.com/acme/widgets/releases/tag/v0.3.0', hook: { kind: 'ok', stdout: 'done' } })
    expect(calls.seen['publish']).toEqual({ target: 'prod-oid', notes: '- A thing\n' })
    expect([...calls.names].sort()).toEqual(['hook-audit', 'publish'])
  })

  it('never undoes a publish when the hook fails', async () => {
    arrange(ready())
    const failedHook: HookOutcome = { kind: 'failed', exitCode: 1, stderr: 'dirty' }
    mocks.hook.mockResolvedValue(failedHook)
    expect(await run(publishRequest)).toMatchObject({ kind: 'published', hook: { kind: 'failed', exitCode: 1 } })
  })

  it('does not audit a skipped hook', async () => {
    const calls = arrange(ready())
    mocks.hook.mockResolvedValue({ kind: 'skipped' })
    await run(publishRequest)
    expect(calls.names).toEqual(['publish'])
  })

  it('refuses early publishing and a different version', async () => {
    arrange(readOf({ kind: 'waiting-merge', version: '0.3.0', releasePr: { number: 612, url: 'u' } }))
    expect(await run(publishRequest)).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    arrange(ready())
    expect(await run({ ...publishRequest, version: '0.4.0' })).toMatchObject({ kind: 'refused', reason: 'state-changed' })
  })

  it('reports a failed release creation without running the hook', async () => {
    const calls = arrange(ready())
    mocks.publish.mockResolvedValue({ ok: false, stderr: 'tag exists' })
    expect(await run(publishRequest)).toEqual({ kind: 'failed', step: 'publish', stderr: 'tag exists' })
    expect(calls.names).toEqual([])
  })
})

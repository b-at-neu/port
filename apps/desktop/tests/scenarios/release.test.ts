// Cutting a release end to end over the real status read and writers: the state GitHub reports in, the pull request, release and audit entries out.
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubHttpResult } from '@/types/platform'
import { releasePrTitle } from '@/utils/release/format'
import { callAction, createTestContext } from '../support/context'
import { createFakeFs } from '../support/fake-platform'
import { createFakeGit } from '../support/fake-git'
import { createFakeGitHub, type FakeRoute } from '../support/fake-github'
import { readyEntry } from '../support/repo-config'

const CONFIG = JSON.stringify({ release: { versionSource: 'tags', versionFiles: [], versionCommand: null, postPublishHook: 'node scripts/after.ts' } })
const MERGED = { number: 12, title: 'Add dark mode', url: 'https://github.com/o/a/pull/12', mergedAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z', author: { __typename: 'User' }, labels: { nodes: [] } }

interface RepositoryState {
  releasePr?: { number: number; url: string; title: string; state: string; merged: boolean }
  closedPr?: { number: number; url: string; title: string; state: string; merged: boolean }
  tags: string[]
}

const reply = (data: unknown): GitHubHttpResult => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ data }) })

async function releaseRig(state: RepositoryState) {
  const dir = mkdtempSync(join(tmpdir(), 'port-release-'))
  const route: FakeRoute = (_request, { query }) => {
    if (query.includes('pageInfo')) return reply({ repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [MERGED] } } })
    if (!query.includes('openReleasePr')) return undefined
    return reply({
      repository: {
        releases: { nodes: state.tags.map((tagName) => ({ tagName, name: tagName, url: `https://github.com/o/a/releases/tag/${tagName}`, publishedAt: '2026-07-01T00:00:00Z', isDraft: false, isPrerelease: false, isLatest: false, description: '', tagCommit: { committedDate: '2026-07-01T00:00:00Z' } })) },
        openReleasePr: { nodes: state.releasePr === undefined ? [] : [state.releasePr] },
        closedReleasePr: { nodes: state.closedPr === undefined ? [] : [state.closedPr] },
        bumpRefs: { nodes: [] },
        integrationHead: { target: { oid: 'int-oid', tree: { oid: 'int-tree' } } },
        productionHead: { target: { oid: 'prod-oid', committedDate: '2026-08-03T00:00:00Z' } },
      },
      viewer: { login: 'octo' },
    })
  }
  const github = createFakeGitHub({ items: [], routes: route })
  const fs = createFakeFs()
  const git = createFakeGit({ fs, root: '/repo', files: { '.claude/port.config.json': CONFIG } })
  const hook = vi.fn(() => Promise.resolve({ ok: true as const, stdout: 'window opened', stderr: '' }))
  const ctx = createTestContext({ platform: { ...github.platform, git: git.git, fs, run: hook, paths: { userData: dir, temp: dir, logs: dir } }, repositories: [readyEntry()] })
  await ctx.ready
  const audit = async (): Promise<{ action: string; result: string }[]> => {
    const text = await readFile(join(dir, 'writes.jsonl'), 'utf8')
    return text.trim().split('\n').map((line) => JSON.parse(line) as { action: string; result: string })
  }
  return { ctx, github, hook, audit }
}

describe('cutting a release', () => {
  it('opens the release pull request for the operator, and audits it', async () => {
    const app = await releaseRig({ tags: ['v0.2.0'] })

    const status = await callAction(app.ctx, 'release.status', { repoId: 'repo-a' as never })
    expect(status).toMatchObject({ ok: true, status: { phase: { kind: 'idle' }, currentVersion: '0.2.0', entries: [{ number: 12 }] } })

    expect(await callAction(app.ctx, 'release.run', { repoId: 'repo-a' as never, step: 'open', version: '0.3.0' })).toEqual({ kind: 'opened' })
    expect(app.github.created).toHaveLength(1)
    expect(app.github.created[0]).toMatchObject({ kind: 'pull-request', base: 'main', head: 'dev', title: releasePrTitle('0.3.0'), assignee: 'octo' })
    expect(app.github.created[0]).toHaveProperty('body', expect.stringContaining('Add dark mode') as string)
    expect(await app.audit()).toMatchObject([{ action: 'release-pr', result: 'applied' }])
  })

  it('refuses to open a release while the pull request for it is already open', async () => {
    const app = await releaseRig({ tags: ['v0.2.0'], releasePr: { number: 40, url: 'https://github.com/o/a/pull/40', title: releasePrTitle('0.3.0'), state: 'OPEN', merged: false } })

    expect(await callAction(app.ctx, 'release.run', { repoId: 'repo-a' as never, step: 'open', version: '0.3.0' })).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    expect(app.github.created).toHaveLength(0)
  })

  it('publishes a merged release at the production head and runs the hook once, auditing both', async () => {
    const app = await releaseRig({ tags: ['v0.2.0'], closedPr: { number: 40, url: 'https://github.com/o/a/pull/40', title: releasePrTitle('0.3.0'), state: 'MERGED', merged: true } })

    const result = await callAction(app.ctx, 'release.run', { repoId: 'repo-a' as never, step: 'publish', version: '0.3.0', notes: '- Dark mode\n' })
    expect(result).toMatchObject({ kind: 'published', hook: { kind: 'ok', stdout: 'window opened' } })
    expect(app.github.created).toEqual([{ kind: 'release', tag: 'v0.3.0', target: 'prod-oid', notes: '- Dark mode\n' }])
    expect(app.hook).toHaveBeenCalledTimes(1)
    expect((await app.audit()).map((entry) => entry.action).sort()).toEqual(['release-hook', 'release-publish'])
  })

  it('keeps the release when the hook fails, and says so', async () => {
    const app = await releaseRig({ tags: ['v0.2.0'], closedPr: { number: 40, url: 'https://github.com/o/a/pull/40', title: releasePrTitle('0.3.0'), state: 'MERGED', merged: true } })
    app.hook.mockResolvedValue({ ok: false as never, kind: 'nonzero', code: 1, stdout: '', stderr: 'dirty tree' } as never)

    const result = await callAction(app.ctx, 'release.run', { repoId: 'repo-a' as never, step: 'publish', version: '0.3.0', notes: 'n' })
    expect(result).toMatchObject({ kind: 'published', hook: { kind: 'failed', exitCode: 1 } })
    expect(app.github.created).toHaveLength(1)
    expect(await app.audit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'release-hook', result: 'failed' })]))
  })

  it('refuses to publish a version that is not the one ready to ship', async () => {
    const app = await releaseRig({ tags: ['v0.2.0'], closedPr: { number: 40, url: 'https://github.com/o/a/pull/40', title: releasePrTitle('0.3.0'), state: 'MERGED', merged: true } })

    expect(await callAction(app.ctx, 'release.run', { repoId: 'repo-a' as never, step: 'publish', version: '0.4.0', notes: 'n' })).toMatchObject({ kind: 'refused', reason: 'state-changed' })
    expect(app.github.created).toHaveLength(0)
  })
})

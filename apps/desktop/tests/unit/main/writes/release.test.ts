import { describe, expect, it } from 'vitest'
import type { GhResult, GhRunner } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import type { AuditEntry } from '@/types/writes'
import { isReleaseAuditEntry } from '@/types/writes'
import { readAuditLog } from '@/main/writes/audit'
import { createBumpBranch, openBumpPr, openReleasePr, publishRelease } from '@/main/writes/release'
import type { ReleaseWriteContext } from '@/types/release'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function context(gh: GhRunner): Promise<ReleaseWriteContext & { readonly dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'release-write-'))
  return { dir, repo: 'acme/widgets', repoId: 'repo-1' as unknown as RepoId, version: '0.3.0', auditDir: dir, scratchDir: dir, gh, now: () => new Date('2026-09-05T14:00:00.000Z') }
}

async function entriesOf(dir: string): Promise<readonly AuditEntry[]> {
  const read = await readAuditLog(dir)
  if (!read.ok) throw new Error('audit unreadable')
  return read.entries
}

function recorder(responses: readonly GhResult[]): { readonly gh: GhRunner; readonly calls: string[][]; readonly bodies: (string | null)[] } {
  const calls: string[][] = []
  const bodies: (string | null)[] = []
  let index = 0
  const gh: GhRunner = async (args) => {
    calls.push([...args])
    const flag = args.findIndex((arg) => arg === '--input' || arg === '--body-file' || arg === '--notes-file')
    bodies.push(flag === -1 ? null : await readFile(args[flag + 1] ?? '', 'utf8'))
    return responses[index++] ?? { ok: true, stdout: '', stderr: '' }
  }
  return { gh, calls, bodies }
}

const OK = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })

describe('createBumpBranch', () => {
  it('posts the tree, the commit and the ref through the Git Data API, then audits once', async () => {
    const { gh, calls, bodies } = recorder([OK('tree-sha\n'), OK('commit-sha\n'), OK('ref-sha\n')])
    const ctx = await context(gh)
    const result = await createBumpBranch(ctx, { head: { oid: 'head-oid', tree: 'base-tree' }, files: [{ path: 'package.json', content: '{"version":"0.3.0"}\n' }] })
    expect(result).toEqual({ ok: true, stdout: 'ref-sha\n' })
    expect(calls.map((call) => call[3])).toEqual(['repos/acme/widgets/git/trees', 'repos/acme/widgets/git/commits', 'repos/acme/widgets/git/refs'])
    expect(JSON.parse(bodies[0] ?? '')).toEqual({ base_tree: 'base-tree', tree: [{ path: 'package.json', mode: '100644', type: 'blob', content: '{"version":"0.3.0"}\n' }] })
    expect(JSON.parse(bodies[1] ?? '')).toEqual({ message: 'bump version to v0.3.0', tree: 'tree-sha', parents: ['head-oid'] })
    expect(JSON.parse(bodies[2] ?? '')).toEqual({ ref: 'refs/heads/bump/v0.3.0', sha: 'commit-sha' })
    const entries = await entriesOf(ctx.dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'release-bump', version: '0.3.0', result: 'applied', failure: null })
    expect((await readdir(ctx.dir)).filter((name) => name.startsWith('release-'))).toEqual([])
  })

  it('stops at the first failing call, audits the failure and deletes its scratch files', async () => {
    const { gh, calls } = recorder([OK('tree-sha'), { ok: false, kind: 'forbidden', stdout: '', stderr: 'no push access' }])
    const ctx = await context(gh)
    const result = await createBumpBranch(ctx, { head: { oid: 'o', tree: 't' }, files: [] })
    expect(result).toEqual({ ok: false, stderr: 'no push access' })
    expect(calls).toHaveLength(2)
    expect((await entriesOf(ctx.dir))[0]).toMatchObject({ result: 'failed', failure: 'no push access' })
    expect((await readdir(ctx.dir)).filter((name) => name.startsWith('release-'))).toEqual([])
  })
})

describe('pull requests', () => {
  it('opens the bump pull request into the integration branch from a body file', async () => {
    const { gh, calls, bodies } = recorder([OK('https://github.com/acme/widgets/pull/611\n')])
    const ctx = await context(gh)
    await openBumpPr(ctx, { integration: 'dev' })
    expect(calls[0]?.slice(0, 11)).toEqual(['pr', 'create', '--repo', 'acme/widgets', '--base', 'dev', '--head', 'bump/v0.3.0', '--title', 'bump version to v0.3.0', '--body-file'])
    expect(calls[0]).not.toContain('--assignee')
    expect(bodies[0]).toContain('v0.3.0')
  })

  it('opens the release pull request from integration into production, assigned to the operator', async () => {
    const { gh, calls, bodies } = recorder([OK('url')])
    const ctx = await context(gh)
    await openReleasePr(ctx, { production: 'main', integration: 'dev', body: '## Release v0.3.0\n', assignee: 'octo-operator' })
    expect(calls[0]).toEqual(expect.arrayContaining(['--base', 'main', '--head', 'dev', '--title', 'Release v0.3.0', '--assignee', 'octo-operator']))
    expect(bodies[0]).toBe('## Release v0.3.0\n')
    expect((await entriesOf(ctx.dir)).every(isReleaseAuditEntry)).toBe(true)
  })

  it('leaves the release pull request unassigned when no login was resolved', async () => {
    const { gh, calls } = recorder([OK('url')])
    await openReleasePr(await context(gh), { production: 'main', integration: 'dev', body: 'b', assignee: null })
    expect(calls[0]).not.toContain('--assignee')
  })
})

describe('publishRelease', () => {
  it('creates the release at the production head with the notes file, marked latest', async () => {
    const { gh, calls, bodies } = recorder([OK('https://github.com/acme/widgets/releases/tag/v0.3.0\n')])
    const ctx = await context(gh)
    const result = await publishRelease(ctx, { target: 'prod-oid', notes: '- A thing\n- Minor enhancements and bug fixes\n' })
    expect(result.ok).toBe(true)
    expect(calls[0]?.slice(0, 9)).toEqual(['release', 'create', 'v0.3.0', '--repo', 'acme/widgets', '--target', 'prod-oid', '--title', 'v0.3.0'])
    expect(calls[0]).toContain('--latest')
    expect(bodies[0]).toBe('- A thing\n- Minor enhancements and bug fixes\n')
    expect((await entriesOf(ctx.dir))[0]).toMatchObject({ action: 'release-publish', result: 'applied' })
  })
})

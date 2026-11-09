import { describe, expect, it } from 'vitest'
import type { GhResult, GhRunner } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import type { AuditEntry } from '@/types/writes'
import { isReleaseAuditEntry } from '@/types/writes'
import { git } from '@/main/platform/git'
import { readAuditLog } from '@/main/writes/audit'
import { createBumpBranch, openBumpPr, openReleasePr, publishRelease } from '@/main/writes/release'
import type { BranchHead, ReleaseGitRunner, ReleaseWriteContext } from '@/types/release'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function context(gh: GhRunner): Promise<ReleaseWriteContext & { readonly dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'release-write-'))
  return { dir, repo: 'acme/widgets', repoId: 'repo-1' as unknown as RepoId, version: '0.3.0', auditDir: dir, scratchDir: dir, root: dir, gh, now: () => new Date('2026-09-05T14:00:00.000Z') }
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

interface Fixture {
  readonly ctx: ReleaseWriteContext & { readonly dir: string }
  readonly origin: string
  readonly clone: string
  readonly key: string
  readonly head: BranchHead
}

const BUMPED = '{\n  "name": "x",\n  "version": "0.3.0"\n}\n'

// A developer's own global config must not leak a signing key (or its absence) into the fixture.
const EMPTY_CONFIG = join(mkdtempSync(join(tmpdir(), 'release-gitconfig-')), 'gitconfig')
writeFileSync(EMPTY_CONFIG, '')
const ISOLATED_ENV: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1' }

const isolatedGit: ReleaseGitRunner = (args, options) => git(args, { ...options, env: { ...process.env, ...ISOLATED_ENV, ...options.env } })

async function out(cwd: string, args: readonly string[]): Promise<string> {
  const result = await isolatedGit(args, { cwd })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${JSON.stringify(result)}`)
  return result.stdout.trim()
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'release-bump-'))
  const origin = join(dir, 'origin.git')
  const clone = join(dir, 'clone')
  const scratch = join(dir, 'scratch')
  const key = join(dir, 'key')
  await mkdir(scratch)
  await out(dir, ['init', '--bare', '-b', 'dev', origin])
  await out(dir, ['clone', origin, clone])
  await out(clone, ['config', 'user.name', 'Port Test'])
  await out(clone, ['config', 'user.email', 'test@example.invalid'])
  await out(clone, ['checkout', '-b', 'dev'])
  await writeFile(join(clone, 'package.json'), '{\n  "name": "x",\n  "version": "0.2.0"\n}\n')
  await writeFile(join(clone, 'other.txt'), 'untouched\n')
  await out(clone, ['add', '.'])
  await out(clone, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'])
  await out(clone, ['push', 'origin', 'dev'])
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  await out(clone, ['config', 'gpg.format', 'ssh'])
  await out(clone, ['config', 'user.signingkey', key])
  const head = { oid: await out(clone, ['rev-parse', 'HEAD']), tree: await out(clone, ['rev-parse', 'HEAD^{tree}']) }
  const ctx = { dir, repo: 'acme/widgets', repoId: 'repo-1' as unknown as RepoId, version: '0.3.0', auditDir: dir, scratchDir: scratch, root: clone, git: isolatedGit, now: () => new Date('2026-09-05T14:00:00.000Z') }
  return { ctx, origin, clone, key, head }
}

async function scratchLeftovers(fx: Fixture): Promise<string[]> {
  return (await readdir(fx.ctx.scratchDir)).filter((name) => name.startsWith('release-'))
}

describe('createBumpBranch', () => {
  it('pushes a signed commit that changes only the version files, then audits once', async () => {
    const fx = await fixture()
    const headBefore = await out(fx.clone, ['rev-parse', 'HEAD'])
    const result = await createBumpBranch(fx.ctx, { head: fx.head, files: [{ path: 'package.json', content: BUMPED }], integration: 'dev' })
    expect(result.ok).toBe(true)
    const header = await out(fx.origin, ['cat-file', 'commit', 'bump/v0.3.0'])
    expect(header).toContain('gpgsig ')
    expect(header).toContain(`parent ${fx.head.oid}`)
    expect(header).toContain('\n\nbump version to v0.3.0')
    expect(await out(fx.origin, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'bump/v0.3.0'])).toBe('package.json')
    const blob = await isolatedGit(['cat-file', 'blob', 'bump/v0.3.0:package.json'], { cwd: fx.origin })
    expect(blob.ok && blob.stdout).toBe(BUMPED)
    expect(await out(fx.clone, ['status', '--porcelain'])).toBe('')
    expect(await out(fx.clone, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(await scratchLeftovers(fx)).toEqual([])
    const entries = await entriesOf(fx.ctx.dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'release-bump', version: '0.3.0', result: 'applied', failure: null })
  })

  it('fails without creating the branch when the commit cannot be signed', async () => {
    const fx = await fixture()
    await out(fx.clone, ['config', 'user.signingkey', join(fx.ctx.dir, 'missing-key')])
    const result = await createBumpBranch(fx.ctx, { head: fx.head, files: [{ path: 'package.json', content: BUMPED }], integration: 'dev' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.stderr).toMatch(/^Couldn't sign the bump commit/)
    expect(await out(fx.origin, ['ls-remote', '--heads', fx.origin, 'refs/heads/bump/v0.3.0'])).toBe('')
    expect(await scratchLeftovers(fx)).toEqual([])
    const entries = await entriesOf(fx.ctx.dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'release-bump', result: 'failed' })
  })

  it('refuses to overwrite a bump branch that already exists on origin', async () => {
    const fx = await fixture()
    await out(fx.clone, ['push', 'origin', 'HEAD:refs/heads/bump/v0.3.0'])
    const result = await createBumpBranch(fx.ctx, { head: fx.head, files: [{ path: 'package.json', content: BUMPED }], integration: 'dev' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.stderr).toContain('bump/v0.3.0 already exists on origin')
    expect(await out(fx.origin, ['rev-parse', 'bump/v0.3.0'])).toBe(fx.head.oid)
  })

  it("fails before writing anything when origin doesn't have the head", async () => {
    const fx = await fixture()
    const result = await createBumpBranch(fx.ctx, { head: { oid: '0'.repeat(40), tree: fx.head.tree }, files: [], integration: 'dev' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.stderr).toContain("doesn't have")
    expect(await out(fx.origin, ['ls-remote', '--heads', fx.origin, 'refs/heads/bump/v0.3.0'])).toBe('')
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

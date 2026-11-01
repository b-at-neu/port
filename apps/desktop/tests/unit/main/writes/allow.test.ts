import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhResult, GhRunner } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import type { StageDenial } from '@/types/stage'
import type { AllowWriteContext } from '@/types/writes'
import { readAuditLog } from '@/main/writes/audit'
import { allowBranchName, proposeAllowRule } from '@/main/writes/allow'

const OK = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })

const DENIAL: StageDenial = { id: 'd1', repoId: 'repo-1' as unknown as RepoId, agent: 'plan', number: 480, toolName: 'Bash', inputSummary: 'pnpm test', rule: 'Bash(pnpm *)', at: '2026-01-01T00:00:00.000Z', sessionKey: null }

async function context(gh: GhRunner): Promise<AllowWriteContext & { readonly dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'allow-write-'))
  return { dir, repo: 'acme/widgets', repoId: DENIAL.repoId, auditDir: dir, scratchDir: dir, gh, now: () => new Date('2026-09-05T14:00:00.000Z') }
}

function recorder(responses: readonly GhResult[]) {
  const calls: string[][] = []
  const bodies: (string | null)[] = []
  let index = 0
  const gh: GhRunner = async (args) => {
    calls.push([...args])
    const flag = args.findIndex((arg) => arg === '--input' || arg === '--body-file')
    bodies.push(flag === -1 ? null : await readFile(args[flag + 1] ?? '', 'utf8'))
    return responses[index++] ?? OK('')
  }
  return { gh, calls, bodies }
}

const PARAMS = { head: { oid: 'head-oid', tree: 'base-tree' }, files: [{ path: '.claude/settings.json', content: '{}\n' }], rule: 'Bash(pnpm *)', denial: DENIAL, integration: 'dev' }

describe('allowBranchName', () => {
  it('is deterministic, slugged and never starts with digits then a dash', () => {
    const name = allowBranchName('Bash(pnpm *)')
    expect(name).toMatch(/^allow\/bash-pnpm-[0-9a-f]{8}$/)
    expect(allowBranchName('Bash(pnpm *)')).toBe(name)
    expect(allowBranchName('Bash(pnpm install)')).not.toBe(name)
  })

  it('caps the slug at 40 characters', () => {
    expect(allowBranchName(`Bash(${'a'.repeat(200)} *)`).length).toBeLessThanOrEqual('allow/'.length + 40 + 9)
  })
})

describe('proposeAllowRule', () => {
  it('commits through the Git Data API, opens the pull request into integration and audits once', async () => {
    const { gh, calls, bodies } = recorder([OK('tree-sha\n'), OK('commit-sha\n'), OK('ref-sha\n'), OK('https://github.com/acme/widgets/pull/612\n')])
    const ctx = await context(gh)
    const result = await proposeAllowRule(ctx, PARAMS)
    expect(result).toEqual({ ok: true, number: 612, url: 'https://github.com/acme/widgets/pull/612' })
    expect(calls.slice(0, 3).map((call) => call[3])).toEqual(['repos/acme/widgets/git/trees', 'repos/acme/widgets/git/commits', 'repos/acme/widgets/git/refs'])
    expect(JSON.parse(bodies[0] ?? '')).toEqual({ base_tree: 'base-tree', tree: [{ path: '.claude/settings.json', mode: '100644', type: 'blob', content: '{}\n' }] })
    expect(JSON.parse(bodies[1] ?? '')).toEqual({ message: '#0 allow Bash(pnpm *) for stage sessions', tree: 'tree-sha', parents: ['head-oid'] })
    expect(JSON.parse(bodies[2] ?? '')).toEqual({ ref: `refs/heads/${allowBranchName('Bash(pnpm *)')}`, sha: 'commit-sha' })
    expect(calls[3]).toEqual(expect.arrayContaining(['--base', 'dev', '--head', allowBranchName('Bash(pnpm *)'), '--title', 'Allow Bash(pnpm *) for stage sessions']))
    expect(calls[3]).not.toContain('--assignee')
    expect(calls[3]).not.toContain('--label')
    expect(bodies[3]).toContain('plan stage on #480')
    expect(bodies[3]).not.toMatch(/closes/i)
    const read = await readAuditLog(ctx.dir)
    expect(read.ok && read.entries).toHaveLength(1)
    expect(read.ok && read.entries[0]).toMatchObject({ action: 'allow-propose', rule: 'Bash(pnpm *)', result: 'applied', failure: null })
    expect((await readdir(ctx.dir)).filter((name) => name.startsWith('allow-'))).toEqual([])
  })

  it('reports a failing commit step and stops', async () => {
    const { gh, calls } = recorder([{ ok: false, kind: 'forbidden', stdout: '', stderr: 'no push access' }])
    const result = await proposeAllowRule(await context(gh), PARAMS)
    expect(result).toEqual({ ok: false, step: 'commit', message: 'no push access' })
    expect(calls).toHaveLength(1)
  })

  it('names the branch when the ref already exists with no open pull request', async () => {
    const { gh } = recorder([OK('t'), OK('c'), { ok: false, kind: 'unknown', stdout: '', stderr: 'Reference already exists' }])
    const result = await proposeAllowRule(await context(gh), PARAMS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(allowBranchName('Bash(pnpm *)'))
  })

  it('reports a failing pull request step and audits the failure', async () => {
    const { gh } = recorder([OK('t'), OK('c'), OK('r'), { ok: false, kind: 'unknown', stdout: '', stderr: 'boom' }])
    const ctx = await context(gh)
    expect(await proposeAllowRule(ctx, PARAMS)).toEqual({ ok: false, step: 'pr', message: 'boom' })
    const read = await readAuditLog(ctx.dir)
    expect(read.ok && read.entries[0]).toMatchObject({ result: 'failed', failure: 'boom' })
  })
})

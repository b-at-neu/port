// Reclaiming disk: finished tickets' worktrees go, active or dirty ones stay, and the audit log says which.
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { callAction, createTestContext } from '../support/context'
import { createFakeFs } from '../support/fake-platform'
import { createFakeGit } from '../support/fake-git'
import { createFakeGitHub, type FakeItem } from '../support/fake-github'
import { readyEntry } from '../support/repo-config'

const REPO_ID = 'repo-a' as never
const treeOf = (name: string): string => `/repo/.claude/worktrees/${name}`

async function reclaimRig(items: readonly FakeItem[], worktrees: readonly { name: string; branch: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'port-reclaim-'))
  const github = createFakeGitHub({ items })
  const fs = createFakeFs()
  const git = createFakeGit({ fs, root: '/repo' })
  for (const { name, branch } of worktrees) await git.addWorktree(treeOf(name), branch, git.head())
  const ctx = createTestContext({ platform: { ...github.platform, git: git.git, fs, paths: { userData: dir, temp: dir, logs: dir } }, repositories: [readyEntry()] })
  await ctx.ready
  const audit = async (): Promise<{ action: string; result: string; removed: string[]; failed: string[]; failure: string | null }[]> => {
    const text = await readFile(join(dir, 'writes.jsonl'), 'utf8')
    return text.trim().split('\n').map((line) => JSON.parse(line) as never)
  }
  return { ctx, github, git, fs, audit }
}

const reclaim = (app: Awaited<ReturnType<typeof reclaimRig>>, issue: number | null = null) => callAction(app.ctx, 'worktrees.reclaim', { id: REPO_ID, issue, force: null })

describe('reclaiming worktrees', () => {
  it('removes a finished ticket and its merged branch, keeps the active and the dirty ones, and audits the removal', async () => {
    const app = await reclaimRig(
      [
        { number: 7, state: 'MERGED' },
        { number: 8, state: 'OPEN' },
        { number: 9, state: 'MERGED' },
      ],
      [
        { name: '7-done', branch: '7-done' },
        { name: '8-active', branch: '8-active' },
        { name: '9-unsaved', branch: '9-unsaved' },
      ],
    )
    app.git.markDirty(treeOf('9-unsaved'))

    expect(await reclaim(app)).toMatchObject({ ok: true, removed: 1 })

    expect(app.git.worktrees().map((tree) => tree.path).sort()).toEqual([treeOf('8-active'), treeOf('9-unsaved')])
    expect(await app.fs.exists(treeOf('7-done'))).toBe(false)
    expect([...app.git.localBranches().keys()].sort()).toEqual(['8-active', '9-unsaved'])
    expect(await app.audit()).toMatchObject([{ action: 'worktree-reclaim', result: 'applied', removed: ['7-done'], failed: [] }])
  })

  it('removes only the named ticket when the operator reclaims one', async () => {
    const app = await reclaimRig(
      [
        { number: 6, state: 'CLOSED' },
        { number: 7, state: 'MERGED' },
      ],
      [
        { name: '6-old', branch: '6-old' },
        { name: '7-done', branch: '7-done' },
      ],
    )

    expect(await reclaim(app, 7)).toMatchObject({ ok: true, removed: 1 })
    expect(app.git.worktrees().map((tree) => tree.path)).toEqual([treeOf('6-old')])
  })

  it('removes nothing when GitHub cannot say which tickets are finished', async () => {
    const app = await reclaimRig([{ number: 7, state: 'MERGED' }], [{ name: '7-done', branch: '7-done' }])
    app.github.failNextRead('rate limited')

    expect(await reclaim(app)).toMatchObject({ ok: false, kind: 'github-unavailable' })
    expect(app.git.worktrees()).toHaveLength(1)
    expect(await app.audit()).toMatchObject([{ action: 'worktree-reclaim', result: 'failed', failure: 'github-unavailable', removed: [] }])
  })
})

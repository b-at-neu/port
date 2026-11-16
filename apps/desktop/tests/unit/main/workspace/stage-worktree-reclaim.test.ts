import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult, GitRunner } from '@/types/platform'
import type { CreateStageWorktreeParams } from '@/types/workspace'
import { createStageWorktree } from '@/main/workspace/stage-worktree'
import { makeTempDir } from '../../../fixtures/fs'

const START_SHA = 'cafe0001'
const DERIVED = '467-stage-worktrees-use-the-issue-branch'

function ok(stdout = ''): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(code: number, stderr = ''): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

type Responder = (args: readonly string[]) => CommandResult | undefined

function recorder(respond: Responder): { readonly git: GitRunner; readonly calls: string[][] } {
  const calls: string[][] = []
  const git: GitRunner = (args) => {
    calls.push([...args])
    const answer = respond(args) ?? (args[0] === 'rev-parse' && args[1] === '--verify' ? ok(`${START_SHA}\n`) : undefined)
    return Promise.resolve(answer ?? ok())
  }
  return { git, calls }
}

function argvOf(calls: readonly string[][], ...prefix: string[]): string[][] {
  return calls.filter((call) => prefix.every((part, i) => call[i] === part))
}

function forEachRef(tip: string, worktreePath: string): CommandResult {
  return ok(`refs/heads/${DERIVED}\t${tip}\t${worktreePath}\n`)
}

async function params(overrides: Partial<CreateStageWorktreeParams> & { readonly git: GitRunner }): Promise<CreateStageWorktreeParams> {
  const root = await makeTempDir()
  return { root, agent: 'impl', number: 467, integration: 'dev', target: { kind: 'issue', title: 'Stage worktrees use the issue branch' }, liveWorktrees: new Set(), random: () => 'abcdef0123', ...overrides }
}

interface LeftoverOptions {
  readonly folder?: string
  readonly live?: boolean
  readonly status?: CommandResult
  readonly ancestorOfOrigin?: CommandResult
  readonly remove?: CommandResult
  readonly create?: boolean
}

async function leftover(options: LeftoverOptions = {}) {
  const root = await makeTempDir()
  const path = join(root, '.claude', 'worktrees', options.folder ?? 'impl-467')
  if (options.create !== false) await mkdir(path, { recursive: true })
  const { git, calls } = recorder((args) => {
    if (args[0] === 'for-each-ref') return forEachRef('aaaa', path)
    if (args[0] === 'status') return options.status ?? ok()
    if (args[0] === 'config' && args[1] === '--get') return nonzero(1)
    if (args[0] === 'merge-base' && args[2] === 'aaaa' && args[3] === `refs/remotes/origin/${DERIVED}`) return options.ancestorOfOrigin ?? ok()
    if (args[0] === 'worktree' && args[1] === 'remove') return options.remove ?? ok()
    return undefined
  })
  const p = await params({ git, root, liveWorktrees: new Set(options.live === true ? [path] : []) })
  return { result: await createStageWorktree(p), calls, path }
}

describe('createStageWorktree — a leftover stage worktree holding the branch', () => {
  it('removes it without --force when it is clean and published', async () => {
    const { result, calls, path } = await leftover()
    // The fake git never deletes the folder, so the new worktree takes the suffixed name.
    expect(result).toMatchObject({ ok: true, path: `${path}-abcdef`, reclaimed: path })
    expect(argvOf(calls, 'status')).toEqual([['status', '--porcelain', '--untracked-files=all']])
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([['worktree', 'remove', path]])
    expect(argvOf(calls, 'worktree', 'add')[0]?.slice(0, 4)).toEqual(['worktree', 'add', '-B', DERIVED])
  })

  it('accepts a folder carrying a hex suffix', async () => {
    const { result } = await leftover({ folder: 'impl-467-0a1b2c' })
    expect(result).toMatchObject({ ok: true })
  })

  it('counts a tip equal to portBase as published when origin has no such branch', async () => {
    const root = await makeTempDir()
    const path = join(root, '.claude', 'worktrees', 'impl-467')
    await mkdir(path, { recursive: true })
    const { git, calls } = recorder((args) => {
      if (args[0] === 'for-each-ref') return forEachRef('aaaa', path)
      if (args[0] === 'config' && args[1] === '--get') return ok('aaaa\n')
      return undefined
    })
    const result = await createStageWorktree(await params({ git, root }))
    expect(result).toMatchObject({ ok: true, reclaimed: path })
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([['worktree', 'remove', path]])
  })

  it('prunes instead of removing when the folder is already gone', async () => {
    const { result, calls, path } = await leftover({ create: false })
    expect(result).toMatchObject({ ok: true, path, reclaimed: path })
    expect(argvOf(calls, 'status')).toEqual([])
    expect(argvOf(calls, 'worktree', 'prune')).toEqual([['worktree', 'prune']])
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([])
  })

  it('refuses when it has uncommitted or untracked changes', async () => {
    const { result, calls, path } = await leftover({ status: ok('?? scratch.txt\n') })
    expect(result).toEqual({ ok: false, message: `Branch ${DERIVED} is checked out in ${path}, which has uncommitted or untracked changes. Commit and push or discard them, then retry — or remove it with: git worktree remove --force "${path}"` })
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([])
  })

  it('refuses when it holds commits that are not on origin', async () => {
    const { result, calls, path } = await leftover({ ancestorOfOrigin: nonzero(1) })
    expect(result).toEqual({ ok: false, message: `Branch ${DERIVED} is checked out in ${path} with commits that aren't on origin. Push the branch, then retry.` })
    expect(argvOf(calls, 'worktree', 'remove')).toEqual([])
  })

  it('refuses when a stage session is still live there', async () => {
    const { result, calls, path } = await leftover({ live: true })
    expect(result).toEqual({ ok: false, message: `Branch ${DERIVED} is checked out in ${path}, where a stage session is still open. Stop that session, then retry.` })
    expect(argvOf(calls, 'status')).toEqual([])
  })

  it('refuses when the folder name does not match the stage pattern', async () => {
    const { result, calls, path } = await leftover({ folder: 'impl-999' })
    expect(result).toEqual({ ok: false, message: `Branch ${DERIVED} is checked out in ${path}, which port didn't create. Finish or remove that worktree, then retry.` })
    expect(argvOf(calls, 'status')).toEqual([])
  })

  it('refuses when git cannot say whether it is clean', async () => {
    const { result } = await leftover({ status: nonzero(128, 'fatal: broken') })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain("Couldn't check the leftover worktree")
  })

  it('refuses with git’s reason when the removal fails', async () => {
    const { result, path } = await leftover({ remove: nonzero(1, 'locked') })
    expect(result).toEqual({ ok: false, message: `Couldn't remove the leftover worktree at ${path}: locked.` })
  })
})

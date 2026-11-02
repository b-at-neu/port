// An in-memory repository for the reclaimer tests: a fake `git`, `gh` and filesystem that stay consistent with each other.
import { posix } from 'node:path'
import { createPathOps } from '@/main/platform/paths'
import type { CommandResult, GhResult, GhRunner, GitRunner } from '@/types/platform'
import type { ReclaimerFs, ReclaimerSeams } from '@/types/reclaimer'

export const MAIN = '/repo'
export const WORKTREES = '/repo/.claude/worktrees'
const MTIME = '2026-01-01T00:00:00.000Z'

export interface FakeWorktree {
  readonly path: string
  readonly head?: string
  /** `null` is a detached HEAD. */
  readonly branch?: string | null
  readonly subject?: string
  readonly locked?: boolean
  readonly lockReason?: string
  /** Whether HEAD is an ancestor of the integration ref. */
  readonly ancestor?: boolean
  readonly status?: readonly string[] | 'fails'
  readonly modifiedAt?: string
}

export interface FakeRepoOptions {
  readonly worktrees?: readonly FakeWorktree[]
  readonly remoteRef?: boolean
  readonly localRef?: boolean
  readonly unmergedBranches?: readonly string[]
  /** `git worktree remove` fails and leaves the worktree registered and on disk. */
  readonly removeFails?: readonly string[]
  /** `git worktree remove` deregisters the worktree but leaves its directory behind. */
  readonly removeLeavesDir?: readonly string[]
  readonly unlockFails?: readonly string[]
  /** errno code a filesystem removal fails with, by path. */
  readonly fsRemoveFails?: Readonly<Record<string, string>>
  /** Directories beside the worktrees that git does not track. */
  readonly orphanDirs?: readonly string[]
  /** Any `worktree list` after the first `worktree remove` fails. */
  readonly listBreaksAfterRemove?: boolean
}

export interface FakeRepo {
  readonly seams: ReclaimerSeams
  /** Every git call with the `-c core.longpaths=true` prefix stripped. */
  readonly calls: string[][]
  /** Every git call exactly as the runner received it. */
  readonly rawCalls: string[][]
  readonly branchesDeleted: string[]
  readonly nodes: Map<string, { kind: 'directory' | 'file'; text: string; modifiedAt: string }>
}

const ok = (stdout = ''): CommandResult => ({ ok: true, stdout, stderr: '' })
const nonzero = (code: number, stderr = ''): CommandResult => ({ ok: false, kind: 'nonzero', code, stdout: '', stderr })

export function createFakeRepo(options: FakeRepoOptions = {}): FakeRepo {
  let worktrees = [...(options.worktrees ?? [])]
  const calls: string[][] = []
  const rawCalls: string[][] = []
  const branchesDeleted: string[] = []
  const nodes: FakeRepo['nodes'] = new Map()
  let removed = false

  const addDir = (path: string, modifiedAt = MTIME): void => void nodes.set(path, { kind: 'directory', text: '', modifiedAt })
  const addFile = (path: string, text: string): void => void nodes.set(path, { kind: 'file', text, modifiedAt: MTIME })

  addDir(MAIN)
  addDir(WORKTREES)
  addDir(`${MAIN}/.git`)
  for (const w of worktrees) {
    addDir(w.path, w.modifiedAt)
    addDir(`${MAIN}/.git/worktrees/${posix.basename(w.path)}`)
    addFile(`${w.path}/.git`, `gitdir: ${MAIN}/.git/worktrees/${posix.basename(w.path)}\n`)
  }
  for (const dir of options.orphanDirs ?? []) addDir(dir)

  const headOf = (w: FakeWorktree): string => w.head ?? `head-${posix.basename(w.path)}`

  function porcelain(): string {
    const stanzas = ['worktree /repo\nHEAD head-main\nbranch refs/heads/dev']
    for (const w of worktrees) {
      const branch = w.branch === undefined ? posix.basename(w.path) : w.branch
      const lines = [`worktree ${w.path}`, `HEAD ${headOf(w)}`, branch === null ? 'detached' : `branch refs/heads/${branch}`]
      if (w.locked === true) lines.push(w.lockReason === undefined ? 'locked' : `locked ${w.lockReason}`)
      stanzas.push(lines.join('\n'))
    }
    return `${stanzas.join('\n\n')}\n`
  }

  const git: GitRunner = (args, cwd) => {
    rawCalls.push([...args])
    const argv = args[0] === '-c' ? args.slice(2) : args
    calls.push([...argv])
    const [a, b] = argv
    const target = worktrees.find((w) => w.path === argv[argv.length - 1])

    if (a === 'worktree' && b === 'list') return Promise.resolve(removed && options.listBreaksAfterRemove === true ? nonzero(128, 'fatal: broken') : ok(porcelain()))
    if (a === 'config') return Promise.resolve(nonzero(1))
    if (a === 'log') return Promise.resolve(ok(worktrees.map((w) => `${headOf(w)} ${w.subject ?? ''}`).join('\n')))
    if (a === 'rev-parse') {
      const exists = argv[3] === `refs/remotes/origin/dev` ? (options.remoteRef ?? true) : (options.localRef ?? false)
      return Promise.resolve(exists ? ok('sha\n') : nonzero(1))
    }
    if (a === 'merge-base') return Promise.resolve(worktrees.find((w) => headOf(w) === argv[2])?.ancestor === true ? ok() : nonzero(1))
    if (a === 'status') {
      const status = worktrees.find((w) => w.path === cwd)?.status ?? []
      return Promise.resolve(status === 'fails' ? nonzero(128, 'fatal: not a git repository') : ok(status.join('\n')))
    }
    if (a === 'worktree' && b === 'remove') {
      if (options.removeFails?.includes(target?.path ?? '') === true) return Promise.resolve(nonzero(1, 'fatal: cannot remove a locked working tree'))
      removed = true
      worktrees = worktrees.filter((w) => w !== target)
      if (target !== undefined && options.removeLeavesDir?.includes(target.path) !== true) {
        for (const key of [...nodes.keys()]) if (key === target.path || key.startsWith(`${target.path}/`)) nodes.delete(key)
      }
      return Promise.resolve(ok())
    }
    if (a === 'worktree' && b === 'unlock') {
      if (options.unlockFails?.includes(target?.path ?? '') === true) return Promise.resolve(nonzero(1, 'fatal: not locked'))
      worktrees = worktrees.map((w) => (w === target ? { ...w, locked: false } : w))
      return Promise.resolve(ok())
    }
    if (a === 'worktree' && b === 'prune') return Promise.resolve(ok())
    if (a === 'branch') {
      if (options.unmergedBranches?.includes(argv[2] ?? '') === true) return Promise.resolve(nonzero(1, "error: the branch 'x' is not fully merged\nhint: delete it with -D"))
      branchesDeleted.push(argv[2] ?? '')
      return Promise.resolve(ok())
    }
    return Promise.reject(new Error(`unexpected git call: ${argv.join(' ')}`))
  }

  const fs: ReclaimerFs = {
    listDirectory: (path) => {
      if (nodes.get(path)?.kind !== 'directory') return Promise.resolve({ ok: false, kind: 'not-found', message: path })
      const entries = [...nodes.entries()].filter(([key]) => key !== path && posix.dirname(key) === path).map(([key, node]) => ({ name: posix.basename(key), kind: node.kind }))
      return Promise.resolve({ ok: true, value: entries })
    },
    statPath: (path) => {
      const node = nodes.get(path)
      return Promise.resolve(node === undefined ? { ok: false, kind: 'not-found', message: path } : { ok: true, value: { kind: node.kind, size: 0, modifiedAt: node.modifiedAt } })
    },
    readTextFile: (path) => {
      const node = nodes.get(path)
      return Promise.resolve(node?.kind === 'file' ? { ok: true, value: node.text } : { ok: false, kind: 'not-found', message: path })
    },
    pathExists: (path) => Promise.resolve(nodes.has(path)),
    removeDirectory: (path) => {
      const code = options.fsRemoveFails?.[path]
      if (code !== undefined) return Promise.resolve({ ok: false, code, message: `${code}: resource busy or locked, rm '${path}'` })
      for (const key of [...nodes.keys()]) if (key === path || key.startsWith(`${path}/`)) nodes.delete(key)
      return Promise.resolve({ ok: true })
    },
  }

  const seams: ReclaimerSeams = { git, fs, pathOps: createPathOps('posix', { home: '/home/u' }), now: () => new Date('2026-02-01T00:00:00.000Z') }
  return { seams, calls, rawCalls, branchesDeleted, nodes }
}

export interface FakeGhOptions {
  readonly states?: Readonly<Record<number, 'OPEN' | 'CLOSED' | 'MERGED' | null>>
  /** Aliases the response reports under `errors[].path`. */
  readonly erroredAliases?: readonly number[]
  readonly failure?: GhResult
}

export interface FakeGh {
  readonly gh: GhRunner
  readonly calls: string[][]
}

export function createFakeGh(options: FakeGhOptions = {}): FakeGh {
  const calls: string[][] = []
  const gh: GhRunner = (args) => {
    calls.push([...args])
    if (options.failure !== undefined) return Promise.resolve(options.failure)
    const query = args.find((arg) => arg.startsWith('query=')) ?? ''
    const repository: Record<string, unknown> = {}
    for (const match of query.matchAll(/n(\d+): issueOrPullRequest/g)) {
      const number = Number(match[1])
      const state = options.states?.[number]
      repository[`n${String(number)}`] = state === undefined || state === null ? null : { __typename: 'Issue', state }
    }
    const errors = (options.erroredAliases ?? []).map((n) => ({ type: 'NOT_FOUND', path: ['repository', `n${String(n)}`], message: 'not found' }))
    return Promise.resolve({ ok: true, stdout: JSON.stringify({ data: { repository }, ...(errors.length > 0 ? { errors } : {}) }), stderr: '' })
  }
  return { gh, calls }
}

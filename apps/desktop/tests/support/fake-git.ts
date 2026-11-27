// An in-memory git repository answering the subcommands port's worktree and config code runs. Anything else throws, so a scenario never reaches a host binary.
import type { Platform } from '@/main/platform'
import type { CommandResult, PlatformFs } from '@/types/platform'

export interface FakeWorktree {
  readonly path: string
  readonly branch: string | null
  readonly head: string
}

export interface FakeGit {
  readonly git: Platform['git']
  /** Creates a commit on top of `parent` (the integration head by default) and returns its sha. */
  readonly commit: (parent?: string) => string
  readonly head: () => string
  readonly setRemoteBranch: (name: string, sha: string) => void
  readonly setLocalBranch: (name: string, sha: string) => void
  readonly addWorktree: (path: string, branch: string | null, sha: string) => Promise<void>
  readonly markDirty: (path: string) => void
  readonly worktrees: () => readonly FakeWorktree[]
  readonly localBranches: () => ReadonlyMap<string, string>
  readonly remoteBranches: () => ReadonlyMap<string, string>
  /** The next call whose first argument is `subcommand` fails with a non-zero exit. */
  readonly failNext: (subcommand: string) => void
}

export interface FakeGitOptions {
  readonly fs: PlatformFs
  readonly root: string
  readonly integration?: string
  /** Committed files readable as `origin/HEAD:<path>`. */
  readonly files?: Readonly<Record<string, string>>
}

const ok = (stdout = ''): CommandResult => ({ ok: true, stdout, stderr: '' })
const nonzero = (code: number, stderr = ''): CommandResult => ({ ok: false, kind: 'nonzero', code, stdout: '', stderr })

const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

export function createFakeGit(options: FakeGitOptions): FakeGit {
  const { fs, root } = options
  const integration = options.integration ?? 'dev'
  const parents = new Map<string, string | null>()
  const locals = new Map<string, string>()
  const remotes = new Map<string, string>()
  const trees: FakeWorktree[] = []
  const dirty = new Set<string>()
  const config = new Map<string, string>()
  const failures: string[] = []
  let counter = 0

  const mint = (parent: string | null): string => {
    counter += 1
    const sha = counter.toString(16).padStart(40, '0')
    parents.set(sha, parent)
    return sha
  }
  const base = mint(null)
  remotes.set(integration, base)

  const isAncestor = (ancestor: string, descendant: string): boolean => {
    for (let at: string | null | undefined = descendant; at !== null && at !== undefined; at = parents.get(at)) if (at === ancestor) return true
    return false
  }

  const resolve = (ref: string): string | undefined => {
    const name = ref.replace(/\^\{commit\}$/, '')
    if (name === 'HEAD' || name === 'origin/HEAD' || name === 'refs/remotes/origin/HEAD') return remotes.get(integration)
    if (name.startsWith('refs/remotes/origin/')) return remotes.get(name.slice('refs/remotes/origin/'.length))
    if (name.startsWith('refs/heads/')) return locals.get(name.slice('refs/heads/'.length))
    if (name.startsWith('origin/')) return remotes.get(name.slice('origin/'.length))
    return locals.get(name) ?? (/^[0-9a-f]{40}$/.test(name) && parents.has(name) ? name : undefined)
  }

  const same = (left: string, right: string): boolean => left.replaceAll('\\', '/') === right.replaceAll('\\', '/')
  const isDirty = (path: string): boolean => [...dirty].some((entry) => same(entry, path))
  const treeAt = (path: string): FakeWorktree | undefined => trees.find((tree) => same(tree.path, path))
  const worktreeOf = (branch: string): string => trees.find((tree) => tree.branch === branch)?.path ?? ''

  const addWorktree = async (path: string, branch: string | null, sha: string): Promise<void> => {
    trees.push({ path, branch, head: sha })
    if (branch !== null) locals.set(branch, sha)
    await fs.ensureDir(path)
  }

  async function run(given: readonly string[], cwd: string): Promise<CommandResult> {
    let args = given
    while (args[0] === '-c') args = args.slice(2)
    const [sub = '', ...rest] = args
    const failure = failures.indexOf(sub)
    if (failure !== -1) {
      failures.splice(failure, 1)
      return nonzero(128, `fake git: ${sub} failed`)
    }

    switch (sub) {
      case 'fetch':
        return ok()
      case 'check-ref-format':
        return ok()
      case 'log':
        return ok()
      case 'rev-parse': {
        if (rest[0] === '--show-toplevel') return ok(`${root}\n`)
        if (rest[0] === '--git-common-dir') return ok(`${root}/.git\n`)
        if (rest[0] === '--git-dir') return ok(`${treeAt(cwd) === undefined ? root : cwd}/.git\n`)
        if (rest[0] === '--abbrev-ref') return ok(`${treeAt(cwd)?.branch ?? 'HEAD'}\n`)
        const quiet = rest.includes('--quiet')
        const ref = rest.filter((arg) => !arg.startsWith('--')).at(-1) ?? 'HEAD'
        const sha = resolve(ref)
        if (sha === undefined) return nonzero(quiet ? 1 : 128, quiet ? '' : `fatal: Needed a single revision`)
        return ok(`${sha}\n`)
      }
      case 'symbolic-ref':
        return ok(`origin/${integration}\n`)
      case 'show': {
        const text = options.files?.[(rest[0] ?? '').replace(/^[^:]*:/, '')]
        return text === undefined ? nonzero(128, 'fatal: path does not exist') : ok(text)
      }
      case 'ls-remote': {
        const pattern = globToRegExp(rest.at(-1) ?? '*')
        const lines = [...remotes].filter(([name]) => pattern.test(`refs/heads/${name}`)).map(([name, sha]) => `${sha}\trefs/heads/${name}`)
        return ok(lines.map((line) => `${line}\n`).join(''))
      }
      case 'for-each-ref': {
        const prefix = rest.at(-1) ?? ''
        const rows = [...locals].filter(([name]) => `refs/heads/${name}`.startsWith(prefix)).map(([name, sha]) => `refs/heads/${name}\t${sha}\t${worktreeOf(name)}`)
        return ok(rows.map((row) => `${row}\n`).join(''))
      }
      case 'merge-base': {
        const [, ancestor = '', descendant = ''] = rest
        const a = resolve(ancestor)
        const d = resolve(descendant)
        if (a === undefined || d === undefined) return nonzero(128, 'fatal: not a valid object name')
        return isAncestor(a, d) ? ok() : nonzero(1)
      }
      case 'config': {
        if (rest[0] === '--get') {
          const value = config.get(rest[1] ?? '')
          return value === undefined ? nonzero(1) : ok(`${value}\n`)
        }
        if (rest[0] === '--get-regexp') return nonzero(1)
        config.set(rest[0] ?? '', rest[1] ?? '')
        return ok()
      }
      case 'status':
        return ok(isDirty(cwd) ?' M file.ts\n' : '')
      case 'branch': {
        if (rest[0] === '-D' || rest[0] === '-d') {
          locals.delete(rest[1] ?? '')
          return ok()
        }
        if (rest[0] === '-r' && rest[1] === '--contains') {
          const tip = rest[2] ?? ''
          return ok([...remotes].filter(([, sha]) => isAncestor(tip, sha)).map(([name]) => `  origin/${name}\n`).join(''))
        }
        return nonzero(128, `fake git: unsupported branch ${rest.join(' ')}`)
      }
      case 'worktree':
        return worktree(rest)
      default:
        throw new Error(`unscripted git call: ${args.join(' ')} (cwd ${cwd})`)
    }
  }

  async function worktree(rest: readonly string[]): Promise<CommandResult> {
    const [action = '', ...operands] = rest
    if (action === 'add') {
      const flag = operands[0]
      const [branch, path, sha] = flag === '--detach' ? [null, operands[1], operands[2]] : [operands[1], operands[2], operands[3]]
      if (path === undefined || sha === undefined) return nonzero(128, 'fatal: usage: git worktree add')
      if (flag === '-b' && branch !== null && branch !== undefined && locals.has(branch)) return nonzero(128, `fatal: a branch named '${branch}' already exists`)
      await addWorktree(path, branch ?? null, sha)
      return ok()
    }
    if (action === 'remove') {
      const path = operands.at(-1) ?? ''
      const index = trees.findIndex((tree) => same(tree.path, path))
      if (index === -1) return nonzero(128, `fatal: '${path}' is not a working tree`)
      if (isDirty(path) && !operands.includes('--force')) return nonzero(128, 'fatal: contains modified or untracked files, use --force to delete it')
      trees.splice(index, 1)
      for (const entry of [...dirty]) if (same(entry, path)) dirty.delete(entry)
      await fs.removeDirectory(path)
      return ok()
    }
    if (action === 'prune') {
      for (let index = trees.length - 1; index >= 0; index -= 1) {
        const tree = trees[index]
        if (tree !== undefined && !(await fs.exists(tree.path))) trees.splice(index, 1)
      }
      return ok()
    }
    if (action === 'unlock') return ok()
    if (action === 'list') {
      const main = `worktree ${root}\nHEAD ${remotes.get(integration) ?? base}\nbranch refs/heads/${integration}\n`
      const others = trees.map((tree) => `worktree ${tree.path}\nHEAD ${tree.head}\n${tree.branch === null ? 'detached' : `branch refs/heads/${tree.branch}`}\n`)
      return ok([main, ...others].join('\n') + '\n')
    }
    return nonzero(128, `fake git: unsupported worktree ${action}`)
  }

  return {
    git: (args, cwd) => run(args, cwd),
    commit: (parent) => mint(parent ?? remotes.get(integration) ?? base),
    head: () => remotes.get(integration) ?? base,
    setRemoteBranch: (name, sha) => {
      remotes.set(name, sha)
    },
    setLocalBranch: (name, sha) => {
      locals.set(name, sha)
    },
    addWorktree,
    markDirty: (path) => {
      dirty.add(path)
    },
    worktrees: () => trees.map((tree) => ({ ...tree })),
    localBranches: () => new Map(locals),
    remoteBranches: () => new Map(remotes),
    failNext: (subcommand) => {
      failures.push(subcommand)
    },
  }
}

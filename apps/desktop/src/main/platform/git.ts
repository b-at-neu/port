import { pathOps } from './paths'
import type { PathOps } from './paths'
import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export interface GitOptions extends Omit<RunCommandOptions, 'whichEnv' | 'platform'> {
  readonly cwd: string
}

// `GIT_TERMINAL_PROMPT=0` plus a blank `GIT_ASKPASS` stop a credential prompt from hanging forever —
// there is no terminal to answer it in a GUI app.
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_OPTIONAL_LOCKS: '0',
}

function withGitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), ...GIT_ENV }
}

/** `-c core.quotepath=false` — a non-ASCII path is otherwise returned octal-escaped. */
export function git(args: readonly string[], options: GitOptions): Promise<CommandResult> {
  return runCommand('git', ['-c', 'core.quotepath=false', ...args], {
    ...options,
    env: withGitEnv(options.env),
  })
}

export type GitLinesResult = { readonly ok: true; readonly lines: readonly string[] } | Exclude<CommandResult, { ok: true }>

export async function gitLines(args: readonly string[], options: GitOptions): Promise<GitLinesResult> {
  const result = await git(args, options)
  if (!result.ok) return result
  const trimmed = result.stdout.replace(/\r?\n$/, '')
  return { ok: true, lines: trimmed === '' ? [] : trimmed.split(/\r?\n/) }
}

// This layer ships invocation and format only; the semantic worktree model lives elsewhere.
export function parsePorcelainStanzas(stdout: string): ReadonlyArray<ReadonlyMap<string, string | true>> {
  const normalized = stdout.replace(/\r\n/g, '\n')
  return normalized
    .split('\n\n')
    .map((stanza) => stanza.trim())
    .filter((stanza) => stanza !== '')
    .map((stanza) => {
      const map = new Map<string, string | true>()
      for (const line of stanza.split('\n')) {
        if (line === '') continue
        const spaceIdx = line.indexOf(' ')
        if (spaceIdx === -1) {
          map.set(line, true)
        } else {
          map.set(line.slice(0, spaceIdx), line.slice(spaceIdx + 1))
        }
      }
      return map
    })
}

export type GitRepoRootResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly kind: 'not-a-repository' }
  | Exclude<CommandResult, { ok: true }>

// Exit 128 outside a repository maps to `not-a-repository` rather than a generic nonzero.
export async function gitRepoRoot(cwd: string, options?: Omit<GitOptions, 'cwd'>): Promise<GitRepoRootResult> {
  const result = await git(['rev-parse', '--show-toplevel'], { ...options, cwd })
  if (!result.ok) {
    if (result.kind === 'nonzero' && result.code === 128) {
      return { ok: false, kind: 'not-a-repository' }
    }
    return result
  }
  const root = result.stdout.replace(/\r?\n$/, '')
  return { ok: true, root: pathOps.toNative(root) }
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

export function defaultGitRunner(): GitRunner {
  return (args, cwd) => git(args, { cwd })
}

/** One level up from the shared `.git` directory, so every worktree of a repository resolves to
 *  the same root. Degrades to `repoRoot` itself on any failure. */
export async function resolveGitBaseRoot(gitRunner: GitRunner, repoRoot: string, ops: PathOps): Promise<string> {
  const result = await gitRunner(['rev-parse', '--git-common-dir'], repoRoot)
  if (!result.ok) return repoRoot
  const common = result.stdout.trim()
  if (common === '') return repoRoot
  try {
    return ops.dirname(ops.resolveFrom(repoRoot, common))
  } catch {
    return repoRoot
  }
}

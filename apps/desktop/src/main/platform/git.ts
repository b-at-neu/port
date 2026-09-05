import { pathOps } from './paths'
import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export interface GitOptions extends Omit<RunCommandOptions, 'whichEnv' | 'platform'> {
  readonly cwd: string
}

/** `GIT_TERMINAL_PROMPT=0` plus a blank `GIT_ASKPASS` stop a credential
 *  prompt from hanging forever — there is no terminal to answer it in a GUI
 *  app. `GIT_OPTIONAL_LOCKS=0` avoids git taking out a lock file behind a
 *  concurrent read. Set on every invocation, never opt-in. */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_OPTIONAL_LOCKS: '0',
}

function withGitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), ...GIT_ENV }
}

/** Every invocation goes through here — never a bare `runCommand('git', …)` —
 *  so the environment and `-c core.quotepath=false` (a non-ASCII path is
 *  otherwise returned octal-escaped) are never forgotten at a call site. */
export function git(args: readonly string[], options: GitOptions): Promise<CommandResult> {
  return runCommand('git', ['-c', 'core.quotepath=false', ...args], {
    ...options,
    env: withGitEnv(options.env),
  })
}

export type GitLinesResult = { readonly ok: true; readonly lines: readonly string[] } | Exclude<CommandResult, { ok: true }>

/** Trailing newline dropped, split on `\r?\n`, no empty tail — the shape
 *  every `git … --porcelain`-adjacent line-oriented invocation wants. */
export async function gitLines(args: readonly string[], options: GitOptions): Promise<GitLinesResult> {
  const result = await git(args, options)
  if (!result.ok) return result
  const trimmed = result.stdout.replace(/\r?\n$/, '')
  return { ok: true, lines: trimmed === '' ? [] : trimmed.split(/\r?\n/) }
}

/** Blank-line-delimited stanzas into one `Map<string, string | true>` per
 *  stanza — the exact shape `git worktree list --porcelain` emits. This
 *  layer ships invocation and format only; the semantic worktree model
 *  (main checkout vs. linked, locked, …) stays in #77. */
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

/** For `-z` output — the only correct handling of a path that itself
 *  contains a newline, which a plain line split would corrupt. */
export function splitNul(stdout: string): readonly string[] {
  const trimmed = stdout.endsWith('\0') ? stdout.slice(0, -1) : stdout
  return trimmed === '' ? [] : trimmed.split('\0')
}

export type GitRepoRootResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly kind: 'not-a-repository' }
  | Exclude<CommandResult, { ok: true }>

/** `rev-parse --show-toplevel`, run through `toNative` since git emits
 *  `C:/Users/…` on Windows. Exit 128 — outside a repository — maps to the
 *  `not-a-repository` state #74 needs, rather than a generic nonzero. */
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

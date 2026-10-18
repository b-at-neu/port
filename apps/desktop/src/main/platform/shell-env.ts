import { isAbsolute } from 'node:path'
import { runExecutable } from '@/main/platform/run'

const DEFAULT_TIMEOUT_MS = 5_000
const BEGIN_SENTINEL = '__PORT_PATH_BEGIN__'
const END_SENTINEL = '__PORT_PATH_END__'

export interface ShouldProbeShellOptions {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly isPackagedFixtureOrE2E: boolean
}

export type ShellEnvSkipReason = 'win32' | 'no-shell' | 'relative-shell' | 'has-term' | 'fixture-or-e2e'

/** Pure: whether probing the login shell is worth the cost at all. A GUI launch has no `TERM`;
 *  a terminal launch does, and its environment is already complete. */
export function shouldProbeShell(options: ShouldProbeShellOptions): ShellEnvSkipReason | null {
  if (options.platform === 'win32') return 'win32'
  if (options.isPackagedFixtureOrE2E) return 'fixture-or-e2e'
  const shell = options.env.SHELL
  if (shell === undefined || shell === '') return 'no-shell'
  if (!isAbsolute(shell)) return 'relative-shell'
  if (options.env.TERM !== undefined && options.env.TERM !== '') return 'has-term'
  return null
}

export type ProbeLoginShellFailureReason = 'timeout' | 'nonzero' | 'no-sentinels' | 'empty-path' | 'spawn-failed'

export type ProbeLoginShellResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: ProbeLoginShellFailureReason }

export interface ProbeLoginShellOptions {
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly run?: typeof runExecutable
}

/** Pure: the text strictly between the *last* BEGIN and the following END, so rc-file noise
 *  printed before or after the sentinels is never mistaken for the PATH. */
export function parseSentinelPath(stdout: string): string | null {
  const beginAt = stdout.lastIndexOf(BEGIN_SENTINEL)
  if (beginAt === -1) return null
  const afterBegin = beginAt + BEGIN_SENTINEL.length
  const endAt = stdout.indexOf(END_SENTINEL, afterBegin)
  if (endAt === -1) return null
  return stdout.slice(afterBegin, endAt)
}

/** Runs the user's login shell once to read its resolved `PATH`. Sentinels bracket the output so
 *  anything an rc file prints to stdout is ignored rather than corrupting the parse. */
export async function probeLoginShellPath(options: ProbeLoginShellOptions): Promise<ProbeLoginShellResult> {
  const run = options.run ?? runExecutable
  const script = `printf '%s' '${BEGIN_SENTINEL}'; printf '%s' "$PATH"; printf '%s' '${END_SENTINEL}'`
  const result = await run(options.shell, ['-i', '-l', '-c', script], {
    cwd: options.env.HOME,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env,
  })

  if (!result.ok) {
    return { ok: false, reason: result.kind === 'timeout' ? 'timeout' : result.kind === 'nonzero' ? 'nonzero' : 'spawn-failed' }
  }
  const path = parseSentinelPath(result.stdout)
  if (path === null) return { ok: false, reason: 'no-sentinels' }
  if (path === '') return { ok: false, reason: 'empty-path' }
  return { ok: true, path }
}

/** Pure: login entries first, then inherited entries not already present. Order is otherwise
 *  preserved and empty segments (a trailing/doubled delimiter) are dropped. */
export function mergePath(loginPath: string, inheritedPath: string, delimiter: string): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const segment of [...loginPath.split(delimiter), ...inheritedPath.split(delimiter)]) {
    if (segment === '' || seen.has(segment)) continue
    seen.add(segment)
    merged.push(segment)
  }
  return merged.join(delimiter)
}

export interface ApplyLoginShellPathDeps {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly isPackagedFixtureOrE2E: boolean
  readonly timeoutMs?: number
  readonly run?: typeof runExecutable
  readonly delimiter?: string
}

/** Composes the probe and merge above and mutates `env.PATH` in place — the whole fix, since
 *  every PATH-sensitive read (`which`, the SDK child) holds a reference to this same object.
 *  Never throws: a failure or skip leaves the inherited PATH standing. */
export async function applyLoginShellPath(deps: ApplyLoginShellPathDeps): Promise<void> {
  const skip = shouldProbeShell(deps)
  if (skip !== null) return

  const shell = deps.env.SHELL
  if (shell === undefined) return // unreachable: `shouldProbeShell` already excluded this

  try {
    const probed = await probeLoginShellPath({ shell, env: deps.env, timeoutMs: deps.timeoutMs, run: deps.run })
    if (!probed.ok) {
      console.warn(`[shell-env] keeping inherited PATH: ${probed.reason}`)
      return
    }
    const delimiter = deps.delimiter ?? ':'
    deps.env.PATH = mergePath(probed.path, deps.env.PATH ?? '', delimiter)
    console.log(`[shell-env] PATH resolved from ${shell}`)
  } catch (error) {
    console.warn(`[shell-env] keeping inherited PATH: ${error instanceof Error ? error.message : String(error)}`)
  }
}

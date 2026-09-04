// The only file under apps/desktop/src/ allowed to import `node:child_process`
// — the `desktop-platform-layer` check in scripts/checks.mjs pins this
// mechanically, so a POSIX shell-out elsewhere is a layer 1 failure, not a
// review comment.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { which as defaultWhich } from './which'
import type { WhichEnv, WhichResult } from './which'

/** The spawnable executables are a literal union, so an adapter reaching for
 *  a POSIX-only utility (`grep`, `find`, …) is a compile-time error rather
 *  than a Windows-only runtime failure. #97 adds `claude` to this union. */
export const KNOWN_COMMANDS = ['git', 'gh'] as const

export type KnownCommand = (typeof KNOWN_COMMANDS)[number]

/**
 * One error rule, everywhere: a condition a human could cause is a value; a
 * programmer mistake is a throw. Every member below is something an operator
 * or environment can legitimately produce.
 */
export type CommandResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'not-found'; readonly command: string; readonly searched: readonly string[] }
  | { readonly ok: false; readonly kind: 'cwd-missing'; readonly cwd: string }
  | { readonly ok: false; readonly kind: 'nonzero'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'signalled'; readonly signal: string; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'timeout'; readonly timeoutMs: number; readonly stderr: string }
  | { readonly ok: false; readonly kind: 'output-too-large'; readonly maxBytes: number }
  | { readonly ok: false; readonly kind: 'spawn-failed'; readonly message: string }

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export interface SpawnOutcome {
  readonly stdout: string
  readonly stderr: string
}

export interface SpawnParams {
  readonly cwd: string | undefined
  readonly timeout: number
  readonly maxBuffer: number
  readonly env: NodeJS.ProcessEnv
}

/** The injectable seam `run.test.ts` uses for its classification table — no
 *  real process is spawned to exercise `not-found`/`nonzero`/`timeout`/etc.
 *  Rejects with a plain, duck-typed failure (never required to be an `Error`
 *  instance), so a fake spawner in a test needs no real `child_process`
 *  error shape. */
export type Spawner = (absPath: string, args: readonly string[], params: SpawnParams) => Promise<SpawnOutcome>

interface SpawnFailureLike {
  readonly code?: unknown
  readonly signal?: unknown
  readonly killed?: unknown
  readonly stdout?: unknown
  readonly stderr?: unknown
  readonly message?: unknown
}

function asFailure(error: unknown): SpawnFailureLike {
  return typeof error === 'object' && error !== null ? error : {}
}

const defaultSpawner: Spawner = (absPath, args, params) =>
  new Promise((resolve, reject) => {
    execFile(
      absPath,
      args,
      {
        cwd: params.cwd,
        timeout: params.timeout,
        maxBuffer: params.maxBuffer,
        env: params.env,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(error.message)
          Object.assign(failure, { code: error.code, signal: error.signal, killed: error.killed, stdout, stderr })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })

function classifySpawnError(error: unknown, absPath: string, ctx: { timeoutMs: number; maxBytes: number }): CommandResult {
  const failure = asFailure(error)
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''

  // Order matches the documented mapping exactly: ETIMEDOUT/killed first (a
  // numeric exit code can coexist with `killed` on some platforms and must
  // not be misread as a normal nonzero exit).
  if (failure.code === 'ETIMEDOUT' || failure.killed === true) {
    return { ok: false, kind: 'timeout', timeoutMs: ctx.timeoutMs, stderr }
  }
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    // No partial stdout carried — truncated output must never reach a JSON
    // parse (ENGINEERING §4, "an absent signal is never read as a passing one").
    return { ok: false, kind: 'output-too-large', maxBytes: ctx.maxBytes }
  }
  if (failure.code === 'ENOENT') {
    return { ok: false, kind: 'not-found', command: absPath, searched: [absPath] }
  }
  if (typeof failure.signal === 'string' && failure.signal !== '') {
    return { ok: false, kind: 'signalled', signal: failure.signal, stderr }
  }
  if (typeof failure.code === 'number') {
    return { ok: false, kind: 'nonzero', code: failure.code, stdout: typeof failure.stdout === 'string' ? failure.stdout : '', stderr }
  }
  const message = typeof failure.message === 'string' ? failure.message : String(error)
  return { ok: false, kind: 'spawn-failed', message }
}

export interface RunExecutableOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly env?: NodeJS.ProcessEnv
  readonly spawner?: Spawner
}

/** The internal primitive: spawns an already-resolved absolute path. Exported
 *  so tests can exercise the classification table without touching `which`. */
export async function runExecutable(
  absPath: string,
  args: readonly string[],
  options: RunExecutableOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const spawner = options.spawner ?? defaultSpawner

  try {
    const { stdout, stderr } = await spawner(absPath, args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: maxBytes,
      env: options.env ?? process.env,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    return classifySpawnError(error, absPath, { timeoutMs, maxBytes })
  }
}

export interface RunCommandOptions extends RunExecutableOptions {
  readonly whichEnv?: WhichEnv
  readonly platform?: NodeJS.Platform
  readonly resolve?: (options: { command: KnownCommand; env: WhichEnv; platform: NodeJS.Platform }) => Promise<WhichResult>
}

async function cwdExists(cwd: string): Promise<boolean> {
  try {
    await stat(cwd)
    return true
  } catch {
    return false
  }
}

/** Resolves a `KnownCommand` on `PATH` (see `which.ts`), pre-checks `cwd`,
 *  then delegates to `runExecutable`. This is the entry point every adapter
 *  in #74–#78 actually calls. */
export async function runCommand(command: KnownCommand, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  if (options.cwd !== undefined && !(await cwdExists(options.cwd))) {
    return { ok: false, kind: 'cwd-missing', cwd: options.cwd }
  }

  const envForResolution = options.whichEnv ?? options.env ?? process.env
  const platform = options.platform ?? process.platform
  const resolve = options.resolve ?? ((resolveOptions) => defaultWhich(resolveOptions))
  const resolved = await resolve({ command, env: envForResolution, platform })
  if (!resolved.ok) return resolved

  return runExecutable(resolved.path, args, options)
}

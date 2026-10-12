// The only file under apps/desktop/src/ allowed to import `node:child_process`.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { which as defaultWhich } from '@/main/platform/which'

import type { RunCommandOptions, CommandResult, KnownCommand, Spawner, RunExecutableOptions } from '@/types/platform'

/** A literal union, so an adapter reaching for a POSIX-only utility is a compile-time error. */
export const KNOWN_COMMANDS = ['git', 'gh', 'node', 'claude'] as const satisfies readonly KnownCommand[]

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export interface E2ERoute {
  readonly fake: string
}

// Module-level, set once from `index.ts` before `registerIpc()` — never re-read from
// `process.env` per call. `null` means E2E mode is off.
let e2eRoute: E2ERoute | null = null

/** Called once, from `index.ts`, before `registerIpc()`. Every `runCommand` call after this
 *  routes to the fake instead of resolving the real executable with `which`. */
export function setE2ERoute(route: E2ERoute | null): void {
  e2eRoute = route
}

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

  // ETIMEDOUT/killed first — a numeric exit code can coexist with `killed` and must not be
  // misread as a normal nonzero exit.
  if (failure.code === 'ETIMEDOUT' || failure.killed === true) {
    return { ok: false, kind: 'timeout', timeoutMs: ctx.timeoutMs, stderr }
  }
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    // No partial stdout carried — truncated output must never reach a JSON parse.
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

/** Spawns an already-resolved absolute path; exported so tests can skip `which`. */
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

async function cwdExists(cwd: string): Promise<boolean> {
  try {
    await stat(cwd)
    return true
  } catch {
    return false
  }
}

// The entry point every higher-level adapter actually calls.
export async function runCommand(command: KnownCommand, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  if (options.cwd !== undefined && !(await cwdExists(options.cwd))) {
    return { ok: false, kind: 'cwd-missing', cwd: options.cwd }
  }

  // E2E mode: every known command routes to the fake through Electron's own binary run as Node,
  // so `which` is never consulted and a host `gh`/`git` can never be reached by accident.
  if (e2eRoute !== null) {
    const env = { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }
    return runExecutable(process.execPath, [e2eRoute.fake, command, ...args], { ...options, env })
  }

  const envForResolution = options.whichEnv ?? options.env ?? process.env
  const platform = options.platform ?? process.platform
  const resolve = options.resolve ?? ((resolveOptions) => defaultWhich(resolveOptions))
  const resolved = await resolve({ command, env: envForResolution, platform })
  if (!resolved.ok) return resolved

  return runExecutable(resolved.path, args, options)
}

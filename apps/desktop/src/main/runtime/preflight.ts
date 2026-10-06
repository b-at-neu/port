// #97: the two composition roots `main/ipc.ts` calls — `runtimePreflight`
// (locate → version → credentials → classify, no network, no subprocess
// beyond `claude --version`, safe on every app start) and `runtimeProbe`
// (registry lookup → locate → credentials → one probe turn), the same
// registry-composing-business-function shape `main/claim.ts`'s own
// `claimPreflight`/`claimApply` already use, so `main/ipc.ts` only ever
// validates the request shape and delegates. Neither ever strips
// `ANTHROPIC_API_KEY`; both only report whether it is present.
import { ensureDirectory } from '../platform/files'
import { readCredentialsTell } from './credentials'
import { resolveClaudeExecutable } from './locate'
import { readClaudeVersion } from './version'
import { classifyPreflight } from './classify'
import { createRuntimeProbe } from './sdk'
import type { RuntimeProbeFn } from './sdk'
import type { RuntimePreflight, RuntimeProbe } from '../../shared/runtime/types'
import { listRepositories, requireReadyRepo } from '../registry'
import type { RegistryDeps } from '../registry'
import type { RepoId } from '../../shared/repos'

function apiKeyInEnvironment(env: NodeJS.ProcessEnv): boolean {
  const value = env['ANTHROPIC_API_KEY']
  return typeof value === 'string' && value !== ''
}

export interface RuntimePreflightDeps {
  readonly resolveClaudeExecutable: typeof resolveClaudeExecutable
  readonly readClaudeVersion: typeof readClaudeVersion
  readonly readCredentialsTell: typeof readCredentialsTell
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly now: () => number
}

const defaultPreflightDeps: RuntimePreflightDeps = {
  resolveClaudeExecutable,
  readClaudeVersion,
  readCredentialsTell,
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
}

export async function runtimePreflight(deps: RuntimePreflightDeps = defaultPreflightDeps): Promise<RuntimePreflight> {
  const now = deps.now()
  const checkedAt = new Date(now).toISOString()
  const located = await deps.resolveClaudeExecutable({ env: deps.env, platform: deps.platform })

  if (!located.ok) {
    return {
      checkedAt,
      executable: located.kind === 'bundled-fallback' ? { path: located.path } : null,
      version: null,
      credentials: null,
      apiKeyInEnvironment: apiKeyInEnvironment(deps.env),
      diagnosis: classifyPreflight({ locate: located.kind, versionUsable: false, credentials: null, now }),
      detail: located.kind === 'bundled-fallback' ? located.path : null,
    }
  }

  const version = await deps.readClaudeVersion()
  const credentials = await deps.readCredentialsTell()

  return {
    checkedAt,
    executable: { path: located.path },
    version: version.ok ? { raw: version.raw, belowMinimum: version.belowMinimum } : null,
    credentials,
    apiKeyInEnvironment: apiKeyInEnvironment(deps.env),
    diagnosis: classifyPreflight({ locate: 'found', versionUsable: version.ok, credentials, now }),
    detail: null,
  }
}

export interface RuntimeProbeDeps {
  readonly listRepositories: typeof listRepositories
  readonly resolveClaudeExecutable: typeof resolveClaudeExecutable
  readonly readCredentialsTell: typeof readCredentialsTell
  readonly probe: RuntimeProbeFn
  readonly ensureDirectory: typeof ensureDirectory
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly now: () => number
}

const defaultRuntimeProbeDeps: RuntimeProbeDeps = {
  listRepositories,
  resolveClaudeExecutable,
  readCredentialsTell,
  probe: createRuntimeProbe(),
  ensureDirectory,
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
}

function resolveReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, list: typeof listRepositories) {
  return requireReadyRepo(registryDeps, "'runtime:probe'", repoId, list)
}

export interface RunRuntimeProbeParams {
  readonly registryDeps: RegistryDeps
  /** `null` runs the probe repository-free, against `probeDir` instead of a
   *  registered repository — no registry lookup at all. */
  readonly repoId: RepoId | null
  /** The app-owned directory a repository-free probe runs in
   *  (`join(app.getPath('userData'), 'runtime-probe')`), created if absent.
   *  Unused in repository mode. */
  readonly probeDir: string
}

/** Resolves the repository (or, in repository-free mode, `params.probeDir`),
 *  then locate → credentials → one probe turn. `repo` in the response is the
 *  resolved `config.repo` display name, `null` in repository-free mode —
 *  "Test connection" never silently picks one without saying which. */
export async function runtimeProbe(params: RunRuntimeProbeParams, deps: RuntimeProbeDeps = defaultRuntimeProbeDeps): Promise<RuntimeProbe> {
  const started = deps.now()
  const checkedAt = new Date(started).toISOString()
  const apiKey = apiKeyInEnvironment(deps.env)

  let repo: string | null
  let cwd: string
  if (params.repoId === null) {
    repo = null
    cwd = params.probeDir
    await deps.ensureDirectory(params.probeDir)
  } else {
    const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps.listRepositories)
    repo = entry.config.repo
    cwd = entry.path
  }

  const located = await deps.resolveClaudeExecutable({ env: deps.env, platform: deps.platform })

  if (!located.ok) {
    return {
      checkedAt,
      repo,
      elapsedMs: deps.now() - started,
      apiKeyInEnvironment: apiKey,
      diagnosis: located.kind === 'not-found' ? 'cli-missing' : 'bundled-fallback',
      detail: located.kind === 'bundled-fallback' ? located.path : null,
    }
  }

  const credentials = await deps.readCredentialsTell()
  const outcome = await deps.probe({ executablePath: located.path, cwd, credentials, now: deps.now() })

  return {
    checkedAt,
    repo,
    elapsedMs: deps.now() - started,
    apiKeyInEnvironment: apiKey,
    diagnosis: outcome.diagnosis,
    detail: outcome.detail,
  }
}

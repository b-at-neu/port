// #97: the two composition roots `main/ipc.ts` calls — `runtimePreflight`
// (locate → version → credentials → classify, no network, no subprocess
// beyond `claude --version`, safe on every app start) and `runtimeProbe`
// (registry lookup → locate → credentials → one probe turn), the same
// registry-composing-business-function shape `main/claim.ts`'s own
// `claimPreflight`/`claimApply` already use, so `main/ipc.ts` only ever
// validates the request shape and delegates. Neither ever strips
// `ANTHROPIC_API_KEY`; both only report whether it is present.
import { readCredentialsTell } from './credentials'
import { resolveClaudeExecutable } from './locate'
import { readClaudeVersion } from './version'
import { classifyPreflight } from './classify'
import { createRuntimeProbe } from './sdk'
import type { RuntimeProbeFn } from './sdk'
import type { RuntimePreflight, RuntimeProbe } from '../../shared/runtime/types'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import type { RepoId, RepositoryEntry } from '../../shared/repos'

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

type ReadyEntry = Extract<RepositoryEntry, { readonly status: 'ready' }>

export interface RuntimeProbeDeps {
  readonly listRepositories: typeof listRepositories
  readonly resolveClaudeExecutable: typeof resolveClaudeExecutable
  readonly readCredentialsTell: typeof readCredentialsTell
  readonly probe: RuntimeProbeFn
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly now: () => number
}

const defaultRuntimeProbeDeps: RuntimeProbeDeps = {
  listRepositories,
  resolveClaudeExecutable,
  readCredentialsTell,
  probe: createRuntimeProbe(),
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
}

/** The same registry-lookup rail every repository-scoped channel applies
 *  (`resolveWorktreesReport`/`resolveItemAction` in `main/ipc.ts`,
 *  `resolveReadyEntry` in `main/claim.ts`) — one more copy rather than a
 *  shared helper, since each caller's error text names its own channel. */
async function resolveReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, list: typeof listRepositories): Promise<ReadyEntry> {
  const result = await list(registryDeps)
  if (!result.ok) throw new Error(`'runtime:probe' could not list repositories: ${result.message}`)
  const entry = result.repositories.find((repository) => repository.id === repoId)
  if (!entry) throw new Error(`'runtime:probe' found no repository registered with id '${repoId}'`)
  if (!('config' in entry)) throw new Error(`'runtime:probe' requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
}

export interface RunRuntimeProbeParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
}

/** Resolves the repository, then locate → credentials → one probe turn.
 *  `repo` in the response is the resolved `config.repo` display name, never
 *  the path — "Test connection" never silently picks one without saying
 *  which. */
export async function runtimeProbe(params: RunRuntimeProbeParams, deps: RuntimeProbeDeps = defaultRuntimeProbeDeps): Promise<RuntimeProbe> {
  const started = deps.now()
  const checkedAt = new Date(started).toISOString()
  const apiKey = apiKeyInEnvironment(deps.env)
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps.listRepositories)
  const located = await deps.resolveClaudeExecutable({ env: deps.env, platform: deps.platform })

  if (!located.ok) {
    return {
      checkedAt,
      repo: entry.config.repo,
      elapsedMs: deps.now() - started,
      apiKeyInEnvironment: apiKey,
      diagnosis: located.kind === 'not-found' ? 'cli-missing' : 'bundled-fallback',
      detail: located.kind === 'bundled-fallback' ? located.path : null,
    }
  }

  const credentials = await deps.readCredentialsTell()
  const outcome = await deps.probe({ executablePath: located.path, cwd: entry.path, credentials, now: deps.now() })

  return {
    checkedAt,
    repo: entry.config.repo,
    elapsedMs: deps.now() - started,
    apiKeyInEnvironment: apiKey,
    diagnosis: outcome.diagnosis,
    detail: outcome.detail,
  }
}

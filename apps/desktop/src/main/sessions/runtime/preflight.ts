// The two composition roots the runtime actions call. Neither strips `ANTHROPIC_API_KEY`; both only report whether it is present.
import type { Platform } from '@/main/platform'
import type { Repos } from '@/main/repos'
import { readCredentialsTell } from '@/main/sessions/runtime/credentials'
import { resolveClaudeExecutable } from '@/main/sessions/runtime/locate'
import { readClaudeVersion } from '@/main/sessions/runtime/version'
import { classifyPreflight } from '@/main/sessions/runtime/classify'
import { runProbe } from '@/main/sessions/runtime/probe'

import type { RuntimePreflight, RuntimeProbe } from '@/types/runtime'
import type { RepoId } from '@/utils/repos'

function apiKeyInEnvironment(env: Platform['env']): boolean {
  const value = env['ANTHROPIC_API_KEY']
  return typeof value === 'string' && value !== ''
}

export async function runtimePreflight(ctx: Pick<Platform, 'which' | 'run' | 'fs' | 'claudeHome' | 'env' | 'clock'>): Promise<RuntimePreflight> {
  const checkedAt = ctx.clock.now().toISOString()
  const located = await resolveClaudeExecutable(ctx)

  if (!located.ok) {
    return {
      checkedAt,
      executable: located.kind === 'bundled-fallback' ? { path: located.path } : null,
      version: null,
      credentials: null,
      apiKeyInEnvironment: apiKeyInEnvironment(ctx.env),
      diagnosis: classifyPreflight({ locate: located.kind, versionUsable: false }),
      detail: located.kind === 'bundled-fallback' ? located.path : null,
    }
  }

  const version = await readClaudeVersion(ctx)
  const credentials = await readCredentialsTell(ctx)

  return {
    checkedAt,
    executable: { path: located.path },
    version: version.ok ? { raw: version.raw, belowMinimum: version.belowMinimum } : null,
    credentials,
    apiKeyInEnvironment: apiKeyInEnvironment(ctx.env),
    diagnosis: classifyPreflight({ locate: 'found', versionUsable: version.ok }),
    detail: null,
  }
}

interface RunRuntimeProbeParams {
  /** `null` runs the probe repository-free, against `probeDir` instead of a
   *  registered repository — no registry lookup at all. */
  readonly repoId: RepoId | null
  /** The app-owned directory a repository-free probe runs in, created if absent. Unused in repository mode. */
  readonly probeDir: string
}

/** `repo` in the response is `null` in repository-free mode — "Test connection" never silently picks one without saying which. */
export async function runtimeProbe(
  ctx: Pick<Platform, 'which' | 'sdk' | 'fs' | 'env' | 'clock'> & { readonly repos: Pick<Repos, 'resolve'> },
  params: RunRuntimeProbeParams,
): Promise<RuntimeProbe> {
  const started = ctx.clock.now().getTime()
  const checkedAt = new Date(started).toISOString()
  const apiKey = apiKeyInEnvironment(ctx.env)

  let repo: string | null
  let cwd: string
  if (params.repoId === null) {
    repo = null
    cwd = params.probeDir
    await ctx.fs.ensureDir(params.probeDir)
  } else {
    const resolution = await ctx.repos.resolve(params.repoId)
    if (!resolution.ok) throw new Error(`'runtime:probe' ${resolution.message}`)
    repo = resolution.entry.config.repo
    cwd = resolution.entry.path
  }

  const located = await resolveClaudeExecutable(ctx)

  if (!located.ok) {
    return {
      checkedAt,
      repo,
      elapsedMs: ctx.clock.now().getTime() - started,
      apiKeyInEnvironment: apiKey,
      diagnosis: located.kind === 'not-found' ? 'cli-missing' : 'bundled-fallback',
      detail: located.kind === 'bundled-fallback' ? located.path : null,
    }
  }

  const outcome = await runProbe(ctx, { executablePath: located.path, cwd })

  return {
    checkedAt,
    repo,
    elapsedMs: ctx.clock.now().getTime() - started,
    apiKeyInEnvironment: apiKey,
    diagnosis: outcome.diagnosis,
    detail: outcome.detail,
  }
}

// `'release:status'` and `'release:run'`'s composition. Every run reads the phase again here and trusts nothing the renderer says beyond the version and the notes.
import type { GitRunner } from '@/types/platform'
import type { IpcMap } from '@/types/ipc'
import type { RegistryDeps } from '@/types/registry'
import type { HookOutcome, ReleaseConfig, ReleaseConfigRead, ReleaseRead, ReleaseRunResult, ReleaseStatus, ReleaseStatusResponse, ReleaseWriteContext, ReleaseWriteResult, VersionFileWrite } from '@/types/release'
import { fetchReleaseStatus, readFileAtRef } from '@/main/github/release'
import { readAtDefaultRef } from '@/main/registry/harness'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/registry'
import { readReleaseConfig } from '@/main/release/config'
import { runPostPublishHook } from '@/main/release/hook'
import { createBumpBranch, openBumpPr, openReleasePr, publishRelease, recordHook } from '@/main/writes/release'
import { renderReleaseBody } from '@/utils/release/changelog'
import { releaseTag } from '@/utils/release/format'
import { normalizeVersion } from '@/utils/release/version'
import type { ReadyEntry } from '@/types/actions'

const MAX_NOTES_CHARS = 125_000

export interface ReleaseChannelDeps {
  readonly listRepositories: typeof listRepositories
  readonly readConfig: (git: GitRunner, root: string) => Promise<ReleaseConfigRead>
  readonly fetchStatus: typeof fetchReleaseStatus
  readonly readFile: typeof readFileAtRef
  readonly createBumpBranch: typeof createBumpBranch
  readonly openBumpPr: typeof openBumpPr
  readonly openReleasePr: typeof openReleasePr
  readonly publishRelease: typeof publishRelease
  readonly runHook: typeof runPostPublishHook
  readonly recordHook: typeof recordHook
  readonly now: () => Date
}

export const defaultReleaseChannelDeps: ReleaseChannelDeps = {
  listRepositories,
  readConfig: (git, root) => readReleaseConfig((path) => readAtDefaultRef(git, root, path)),
  fetchStatus: fetchReleaseStatus,
  readFile: readFileAtRef,
  createBumpBranch,
  openBumpPr,
  openReleasePr,
  publishRelease,
  runHook: runPostPublishHook,
  recordHook,
  now: () => new Date(),
}

type Resolved = { readonly read: ReleaseRead; readonly config: ReleaseConfig } | { readonly read: Extract<ReleaseRead, { ok: false }>; readonly config: null }

// Fails closed: an unreadable config yields a failed read, so no action is offered.
async function readState(registryDeps: RegistryDeps, entry: ReadyEntry, deps: ReleaseChannelDeps): Promise<Resolved> {
  const config = await deps.readConfig(registryDeps.git, entry.path)
  if (!config.ok) return { read: { ok: false, message: config.message, readAt: deps.now().toISOString() }, config: null }
  const read = await deps.fetchStatus({
    repo: { owner: entry.config.owner, name: entry.config.name },
    integration: entry.config.branches.integration,
    production: entry.config.branches.production,
    moduleEnabled: entry.config.modules.release,
    config: config.config,
  })
  return { read, config: config.config }
}

export async function resolveReleaseStatus(registryDeps: RegistryDeps, request: IpcMap['release:status']['request'], deps: ReleaseChannelDeps = defaultReleaseChannelDeps): Promise<ReleaseStatusResponse> {
  const repoId = requireRepoId(request?.repoId, "'release:status'")
  const entry = await requireReadyRepo(registryDeps, "'release:status'", repoId, deps.listRepositories)
  const { read } = await readState(registryDeps, entry, deps)
  return read.ok ? { ok: true, status: read.status } : read
}

function refused(reason: Extract<ReleaseRunResult, { kind: 'refused' }>['reason'], message: string): ReleaseRunResult {
  return { kind: 'refused', reason, message }
}

const UNSUPPORTED_PHASES: ReadonlySet<string> = new Set(['off', 'single-branch', 'misconfigured', 'needs-terminal'])

function stateChanged(status: ReleaseStatus): ReleaseRunResult {
  if (UNSUPPORTED_PHASES.has(status.phase.kind)) return refused('unsupported', "This repository's release can't be cut from the app.")
  return refused('state-changed', 'The release moved on while this screen was open. Refresh and look again.')
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop() ?? ''
}

// Re-serializes the way `scripts/dev-window.ts` does, so a bump diff touches only the version.
function withVersion(text: string, version: string): string | null {
  try {
    const manifest: unknown = JSON.parse(text)
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest) || typeof (manifest as { version?: unknown }).version !== 'string') return null
    return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
  } catch {
    return null
  }
}

async function bumpFiles(entry: ReadyEntry, config: ReleaseConfig, oid: string, version: string, deps: ReleaseChannelDeps): Promise<readonly VersionFileWrite[] | string> {
  const files: VersionFileWrite[] = []
  for (const path of config.versionFiles) {
    const read = await deps.readFile({ repo: { owner: entry.config.owner, name: entry.config.name }, path, ref: oid })
    if (!read.ok) return `Couldn't read ${path}: ${read.message}`
    const content = withVersion(read.text, version)
    if (content === null) return `${path} isn't a JSON file with a version field, so the app can't bump it. Cut this release with /port:release in a terminal.`
    files.push({ path, content })
  }
  return files
}

interface RunContext {
  readonly entry: ReadyEntry
  readonly config: ReleaseConfig
  readonly status: ReleaseStatus
  readonly integrationHead: Extract<ReleaseRead, { ok: true }>['integrationHead']
  readonly viewer: string | null
  readonly write: ReleaseWriteContext
  readonly deps: ReleaseChannelDeps
}

type Step = 'bump' | 'bump-pr' | 'release-pr'

function failed(step: Step | 'publish', result: ReleaseWriteResult): ReleaseRunResult | null {
  return result.ok ? null : { kind: 'failed', step, stderr: result.stderr }
}

async function runOpen(ctx: RunContext, version: string): Promise<ReleaseRunResult> {
  const { status, config, deps } = ctx
  const phase = status.phase
  const production = status.production
  if (phase.kind !== 'idle' && phase.kind !== 'bumped' && phase.kind !== 'waiting-bump') return stateChanged(status)
  if (phase.kind === 'idle' && status.releases.some((release) => release.tagName === releaseTag(version))) return refused('tag-exists', `v${version} is already released.`)
  if (phase.kind !== 'idle' && phase.version !== version) return refused('state-changed', `This release is already v${phase.version}.`)
  if (production === null) return stateChanged(status)

  const integration = status.integration
  if (phase.kind === 'idle' && config.versionSource === 'package') {
    if (ctx.integrationHead === null) return refused('state-changed', `${integration} has no head to bump from.`)
    const files = await bumpFiles(ctx.entry, config, ctx.integrationHead.oid, version, deps)
    if (typeof files === 'string') return refused('unsupported', files)
    const bump = failed('bump', await deps.createBumpBranch(ctx.write, { head: ctx.integrationHead, files }))
    if (bump !== null) return bump
  }

  const needsBumpPr = config.versionSource === 'package' && (phase.kind === 'idle' || (phase.kind === 'waiting-bump' && phase.bumpPr === null))
  if (needsBumpPr) {
    const bumpPr = failed('bump-pr', await deps.openBumpPr(ctx.write, { integration }))
    if (bumpPr !== null) return bumpPr
  }

  const needsReleasePr = phase.kind !== 'waiting-bump' || phase.releasePr === null
  if (needsReleasePr) {
    const releasePr = failed('release-pr', await deps.openReleasePr(ctx.write, { production, integration, body: renderReleaseBody(version, status.entries), assignee: ctx.viewer }))
    if (releasePr !== null) return releasePr
  }
  return { kind: 'opened' }
}

async function runPublish(ctx: RunContext, version: string, notes: string): Promise<ReleaseRunResult> {
  const { status, config, deps } = ctx
  if (status.phase.kind !== 'ready-to-publish' || status.phase.version !== version) return stateChanged(status)
  if (status.releases.some((release) => release.tagName === releaseTag(version))) return refused('tag-exists', `v${version} is already released.`)
  if (status.productionHead === null) return refused('state-changed', `${status.production ?? 'The production branch'} has no head to tag.`)

  const published = await deps.publishRelease(ctx.write, { target: status.productionHead, notes })
  if (!published.ok) return { kind: 'failed', step: 'publish', stderr: published.stderr }

  const hook: HookOutcome = await deps.runHook({ command: config.postPublishHook, cwd: ctx.entry.path })
  if (hook.kind !== 'skipped') {
    const outcome: ReleaseWriteResult = hook.kind === 'ok' ? { ok: true, stdout: hook.stdout } : { ok: false, stderr: hook.kind === 'failed' ? hook.stderr : hook.message }
    await deps.recordHook(ctx.write, config.postPublishHook === null ? null : config.postPublishHook.split(/\s+/), outcome)
  }
  return { kind: 'published', url: lastLine(published.stdout), hook }
}

export async function resolveReleaseRun(
  registryDeps: RegistryDeps,
  request: IpcMap['release:run']['request'],
  auditDir: string,
  scratchDir: string,
  deps: ReleaseChannelDeps = defaultReleaseChannelDeps,
): Promise<ReleaseRunResult> {
  const repoId = requireRepoId(request?.repoId, "'release:run'")
  if (request.step !== 'open' && request.step !== 'publish') throw new Error("'release:run' step must be 'open' or 'publish'")
  if (request.step === 'publish' && (typeof request.notes !== 'string' || request.notes.trim() === '' || request.notes.length > MAX_NOTES_CHARS)) {
    throw new Error(`'release:run' requires notes of 1 to ${String(MAX_NOTES_CHARS)} characters`)
  }
  const version = typeof request.version === 'string' ? normalizeVersion(request.version) : null
  if (version === null) return refused('invalid-version', 'Use X.Y.Z, optionally with a prerelease like 1.5.0-beta.1.')

  const entry = await requireReadyRepo(registryDeps, "'release:run'", repoId, deps.listRepositories)
  const { read, config } = await readState(registryDeps, entry, deps)
  if (!read.ok || config === null) return refused('state-changed', `Couldn't read the release state: ${read.ok ? 'no config' : read.message}`)

  const ctx: RunContext = {
    entry,
    config,
    status: read.status,
    integrationHead: read.integrationHead,
    viewer: read.viewer,
    write: { repo: entry.config.repo, repoId, version, auditDir, scratchDir, now: deps.now },
    deps,
  }
  return request.step === 'open' ? runOpen(ctx, version) : runPublish(ctx, version, request.notes)
}

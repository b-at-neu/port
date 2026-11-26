// `'release:status'`, `'release:issues'` and `'release:run'`'s composition. Every run reads the phase again here and trusts nothing the renderer says beyond the version and the notes.
import type { AppContext } from '@/main/app/context'
import type { ReleaseIssuesRequest, ReleaseRunRequest, HookOutcome, ReleaseConfig, ReleaseIssuesResponse, ReleaseRead, ReleaseRunResult, ReleaseStatus, ReleaseStatusResponse, ReleaseWriteContext, ReleaseWriteResult, VersionFileWrite } from '@/types/release'
import { fetchReleaseStatus, readFileAtRef } from '@/main/github/release'
import { fetchReleaseIssues } from '@/main/github/release-issues'
import { readAtDefaultRef } from '@/main/repos/config/harness'
import { readyEntryOf } from '@/main/pipeline/context'
import { readReleaseConfig } from '@/main/features/release/config'
import { runPostPublishHook } from '@/main/features/release/hook'
import { createBumpBranch, openBumpPr, openReleasePr, publishRelease, recordHook } from '@/main/github/writes/release'
import { renderReleaseBody } from '@/utils/release/changelog'
import { releaseTag } from '@/utils/release/format'
import { normalizeVersion } from '@/utils/release/version'
import type { ReadyEntry } from '@/types/actions'
import type { RepoId } from '@/utils/repos'

type ReleaseContext = Pick<AppContext, 'repos' | 'git' | 'githubHttp' | 'ghWrite' | 'run' | 'clock' | 'paths'>

const unlistable = (subject: string) => (message: string) => `${subject} could not list repositories: ${message}`

type Resolved = { readonly read: ReleaseRead; readonly config: ReleaseConfig } | { readonly read: Extract<ReleaseRead, { ok: false }>; readonly config: null }

// Fails closed: an unreadable config yields a failed read, so no action is offered.
async function readState(ctx: ReleaseContext, entry: ReadyEntry): Promise<Resolved> {
  const config = await readReleaseConfig((path) => readAtDefaultRef(ctx, entry.path, path))
  if (!config.ok) return { read: { ok: false, message: config.message, readAt: ctx.clock.now().toISOString() }, config: null }
  const read = await fetchReleaseStatus(ctx, {
    repo: { owner: entry.config.owner, name: entry.config.name },
    integration: entry.config.branches.integration,
    production: entry.config.branches.production,
    moduleEnabled: entry.config.modules.release,
    config: config.config,
  })
  return { read, config: config.config }
}

export async function releaseStatusOf(ctx: ReleaseContext, input: { readonly repoId: RepoId }): Promise<ReleaseStatusResponse> {
  const entry = await readyEntryOf(ctx, "'release:status'", input.repoId, unlistable("'release:status'"))
  const { read } = await readState(ctx, entry)
  return read.ok ? { ok: true, status: read.status } : read
}

export async function releaseIssuesOf(ctx: ReleaseContext, input: ReleaseIssuesRequest): Promise<ReleaseIssuesResponse> {
  const entry = await readyEntryOf(ctx, "'release:issues'", input.repoId, unlistable("'release:issues'"))
  return fetchReleaseIssues(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, tag: input.tag, previousTag: input.previousTag })
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

async function bumpFiles(ctx: ReleaseContext, entry: ReadyEntry, config: ReleaseConfig, oid: string, version: string): Promise<readonly VersionFileWrite[] | string> {
  const files: VersionFileWrite[] = []
  for (const path of config.versionFiles) {
    const read = await readFileAtRef(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, path, ref: oid })
    if (!read.ok) return `Couldn't read ${path}: ${read.message}`
    const content = withVersion(read.text, version)
    if (content === null) return `${path} isn't a JSON file with a version field, so the app can't bump it. Cut this release with /port:release in a terminal.`
    files.push({ path, content })
  }
  return files
}

interface RunContext {
  readonly platform: ReleaseContext
  readonly entry: ReadyEntry
  readonly config: ReleaseConfig
  readonly status: ReleaseStatus
  readonly integrationHead: Extract<ReleaseRead, { ok: true }>['integrationHead']
  readonly viewer: string | null
  readonly write: ReleaseWriteContext
}

type Step = 'bump' | 'bump-pr' | 'release-pr'

function failed(step: Step | 'publish', result: ReleaseWriteResult): ReleaseRunResult | null {
  return result.ok ? null : { kind: 'failed', step, stderr: result.stderr }
}

async function runOpen(ctx: RunContext, version: string): Promise<ReleaseRunResult> {
  const { status, config } = ctx
  const phase = status.phase
  const production = status.production
  if (phase.kind !== 'idle' && phase.kind !== 'bumped' && phase.kind !== 'waiting-bump') return stateChanged(status)
  if (phase.kind === 'idle' && status.releases.some((release) => release.tagName === releaseTag(version))) return refused('tag-exists', `v${version} is already released.`)
  if (phase.kind !== 'idle' && phase.version !== version) return refused('state-changed', `This release is already v${phase.version}.`)
  if (production === null) return stateChanged(status)

  const integration = status.integration
  if (phase.kind === 'idle' && config.versionSource === 'package') {
    if (ctx.integrationHead === null) return refused('state-changed', `${integration} has no head to bump from.`)
    const files = await bumpFiles(ctx.platform, ctx.entry, config, ctx.integrationHead.oid, version)
    if (typeof files === 'string') return refused('unsupported', files)
    const bump = failed('bump', await createBumpBranch(ctx.platform, ctx.write, { head: ctx.integrationHead, files, integration }))
    if (bump !== null) return bump
  }

  const needsBumpPr = config.versionSource === 'package' && (phase.kind === 'idle' || (phase.kind === 'waiting-bump' && phase.bumpPr === null))
  if (needsBumpPr) {
    const bumpPr = failed('bump-pr', await openBumpPr(ctx.platform, ctx.write, { integration }))
    if (bumpPr !== null) return bumpPr
  }

  const needsReleasePr = phase.kind !== 'waiting-bump' || phase.releasePr === null
  if (needsReleasePr) {
    const releasePr = failed('release-pr', await openReleasePr(ctx.platform, ctx.write, { production, integration, body: renderReleaseBody(version, status.entries), assignee: ctx.viewer }))
    if (releasePr !== null) return releasePr
  }
  return { kind: 'opened' }
}

async function runPublish(ctx: RunContext, version: string, notes: string): Promise<ReleaseRunResult> {
  const { status, config } = ctx
  if (status.phase.kind !== 'ready-to-publish' || status.phase.version !== version) return stateChanged(status)
  if (status.releases.some((release) => release.tagName === releaseTag(version))) return refused('tag-exists', `v${version} is already released.`)
  if (status.productionHead === null) return refused('state-changed', `${status.production ?? 'The production branch'} has no head to tag.`)

  const published = await publishRelease(ctx.platform, ctx.write, { target: status.productionHead, notes })
  if (!published.ok) return { kind: 'failed', step: 'publish', stderr: published.stderr }

  const hook: HookOutcome = await runPostPublishHook(ctx.platform, { command: config.postPublishHook, cwd: ctx.entry.path })
  if (hook.kind !== 'skipped') {
    const outcome: ReleaseWriteResult = hook.kind === 'ok' ? { ok: true, stdout: hook.stdout } : { ok: false, stderr: hook.kind === 'failed' ? hook.stderr : hook.message }
    await recordHook(ctx.platform, ctx.write, config.postPublishHook === null ? null : config.postPublishHook.split(/\s+/), outcome)
  }
  return { kind: 'published', url: lastLine(published.stdout), hook }
}

export async function releaseRunOf(ctx: ReleaseContext, input: ReleaseRunRequest): Promise<ReleaseRunResult> {
  const { repoId } = input
  const version = normalizeVersion(input.version)
  if (version === null) return refused('invalid-version', 'Use X.Y.Z, optionally with a prerelease like 1.5.0-beta.1.')

  const entry = await readyEntryOf(ctx, "'release:run'", repoId, unlistable("'release:run'"))
  const { read, config } = await readState(ctx, entry)
  if (!read.ok || config === null) return refused('state-changed', `Couldn't read the release state: ${read.ok ? 'no config' : read.message}`)

  const run: RunContext = {
    platform: ctx,
    entry,
    config,
    status: read.status,
    integrationHead: read.integrationHead,
    viewer: read.viewer,
    write: { repo: entry.config.repo, repoId, version, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp, root: entry.path },
  }
  return input.step === 'open' ? runOpen(run, version) : runPublish(run, version, input.notes)
}

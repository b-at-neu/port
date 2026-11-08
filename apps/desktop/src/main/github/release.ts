// fetchReleaseStatus: the state read and the merged-PR read behind the Releases screen. Reads fail toward showing less with a note, except where a partial read would enable a write.
import { githubHttp } from '@/main/platform/github-http'
import type { GhResult, GitHubTransport } from '@/types/platform'
import type { GitHubRepoRef } from '@/types/github'
import type {
  BranchHead,
  ClosedReleasePrInput,
  BumpBranchInput,
  PhaseInput,
  ReleaseConfig,
  ReleaseEntry,
  ReleaseInfo,
  ReleasePhase,
  ReleaseRead,
  ReleaseStatus,
  ReleasePrInput,
} from '@/types/release'
import { bodyOf, classifyFailure, describeHttp, parseEnvelope } from '@/main/github/envelope'
import { RAW_ACCEPT, repoGraphqlRequest, restRequest } from '@/main/github/request'
import { RELEASES_PAGE, STATE_ALIASES, buildStateQuery, stateVariables } from '@/main/github/release-query'
import { readMergedPrs } from '@/main/github/release-prs'
import { BUMP_BRANCH_DIR, versionOfBumpBranch } from '@/utils/release/format'
import { resolvePhase } from '@/main/release/state'
import { normalizeVersion, parseVersion, stripPrerelease } from '@/utils/release/version'

const SAFE_REF = /^[A-Za-z0-9._/-]+$/

export type Obj = Readonly<Record<string, unknown>>

export function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function nodesOf(value: unknown): readonly Obj[] {
  const nodes = obj(value)?.nodes
  return Array.isArray(nodes) ? nodes.flatMap((node) => (obj(node) === null ? [] : [node as Obj])) : []
}

function failure(message: string, readAt: string): ReleaseRead {
  return { ok: false, message, readAt }
}

export function describe(result: Exclude<GhResult, { ok: true }>): string {
  if ('stderr' in result && result.stderr.trim() !== '') return result.stderr.trim()
  if (result.kind === 'not-found') return "gh isn't on PATH"
  if (result.kind === 'spawn-failed') return result.message
  return result.kind
}

function prOf(node: Obj | undefined): ReleasePrInput | null {
  const number = node?.number
  const url = str(node?.url)
  if (node === undefined || typeof number !== 'number' || url === null) return null
  return { number, url, title: str(node.title) ?? '' }
}

function closedPrOf(node: Obj | undefined): ClosedReleasePrInput | null {
  const pr = prOf(node)
  return pr === null || node === undefined ? null : { ...pr, merged: node.merged === true }
}

function releaseOf(node: Obj): Omit<ReleaseInfo, 'previousTag'> | null {
  const tagName = str(node.tagName)
  if (tagName === null || node.isDraft === true) return null
  return {
    tagName,
    name: str(node.name) ?? tagName,
    url: str(node.url) ?? '',
    publishedAt: str(node.publishedAt),
    isPrerelease: node.isPrerelease === true,
    isLatest: node.isLatest === true,
    description: str(node.description) ?? '',
  }
}

function bumpOf(node: Obj): BumpBranchInput {
  const pr = nodesOf(node.associatedPullRequests)[0]
  const number = pr?.number
  const url = str(pr?.url)
  return { name: `${BUMP_BRANCH_DIR}${str(node.name) ?? ''}`, pr: typeof number === 'number' && url !== null ? { number, url } : null }
}

// `null` for a missing blob, a non-JSON file or one without a string `version`.
function versionIn(blob: unknown): string | null {
  const text = str(obj(blob)?.text)
  if (text === null) return null
  try {
    return str((JSON.parse(text) as { version?: unknown }).version)
  } catch {
    return null
  }
}

function headOf(ref: unknown): BranchHead | null {
  const target = obj(obj(ref)?.target)
  const oid = str(target?.oid)
  const tree = str(obj(target?.tree)?.oid)
  return oid === null ? null : { oid, tree: tree ?? '' }
}

export function parseBody(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

export interface FetchReleaseStatusParams {
  readonly repo: GitHubRepoRef
  readonly integration: string
  readonly production: string | null
  readonly moduleEnabled: boolean
  readonly config: ReleaseConfig
  readonly github?: GitHubTransport
  readonly now?: () => Date
}

const GATHERING: ReadonlySet<ReleasePhase['kind']> = new Set(['idle', 'bumped', 'waiting-bump', 'ready-to-publish'])

function guardStatus(params: FetchReleaseStatusParams, phase: ReleasePhase, readAt: string): ReleaseRead {
  const status: ReleaseStatus = {
    phase,
    versionSource: params.config.versionSource,
    production: params.production,
    integration: params.integration,
    currentVersion: null,
    sinceTag: null,
    entries: [],
    truncatedNote: null,
    releases: [],
    productionHead: null,
    postPublishHook: params.config.postPublishHook,
    readAt,
  }
  return { ok: true, status, integrationHead: null, viewer: null }
}

export async function fetchReleaseStatus(params: FetchReleaseStatusParams): Promise<ReleaseRead> {
  const github = params.github ?? githubHttp
  const readAt = (params.now ?? (() => new Date()))().toISOString()
  const { config, repo, integration, production } = params

  const base: PhaseInput = {
    moduleEnabled: params.moduleEnabled,
    production,
    versionSource: config.versionSource,
    versionFiles: config.versionFiles,
    versionCommand: config.versionCommand,
    bumpBranches: [],
    openReleasePr: null,
    lastClosedReleasePr: null,
    publishedTags: new Set(),
    integrationVersion: null,
    productionVersion: null,
    gatherEmpty: false,
  }
  const guard = resolvePhase(base)
  if (guard.kind !== 'idle' || production === null) return guardStatus(params, guard, readAt)
  if (![integration, production, ...config.versionFiles].every((ref) => SAFE_REF.test(ref))) {
    return failure('A branch or version file name in the config has characters port will not put in a GitHub query.', readAt)
  }

  const versionFile = config.versionSource === 'package' ? (config.versionFiles[0] ?? null) : null
  const result = await github(repoGraphqlRequest(buildStateQuery(versionFile !== null), repo, stateVariables({ integration, production, versionFile })))
  const text = bodyOf(result)
  const parsed = text === undefined ? undefined : parseEnvelope(text)
  const verdict = classifyFailure(result, parsed)
  if (verdict.kind !== 'ok') return failure(verdict.message, readAt)
  const body = parsed?.ok === true ? parsed.value : null
  const repository = obj(body?.data?.repository)
  if (body === null || repository === null) return failure('GitHub returned no repository data.', readAt)

  // A failed `viewer` read only leaves a pull request unassigned, so it never counts as unavailable state.
  const stateErrors = (body.errors ?? []).filter((error) => error.path?.[0] !== 'viewer')
  const unavailable = STATE_ALIASES.filter((alias) => stateErrors.some((error) => error.path?.[1] === alias))
  const anonymous = stateErrors.some((error) => error.path?.[1] === undefined)
  if (unavailable.length > 0 || anonymous) {
    return failure(`GitHub couldn't read ${unavailable.length > 0 ? unavailable.join(', ') : 'part of the release state'}, so no release action is offered.`, readAt)
  }

  // The page carries one release beyond the last one shown, only so that one has a known predecessor.
  const tagged = nodesOf(repository.releases).flatMap((node) => {
    const release = releaseOf(node)
    return release === null ? [] : [{ release, taggedAt: str(obj(node.tagCommit)?.committedDate) }]
  })
  const fetched = tagged.map((entry) => entry.release)
  const allReleases: readonly ReleaseInfo[] = fetched.map((release, index) => ({ ...release, previousTag: fetched[index + 1]?.tagName ?? null }))
  const releases = allReleases.slice(0, RELEASES_PAGE)
  const publishedTags = new Set(allReleases.map((release) => release.tagName))
  const integrationHead = headOf(repository.integrationHead)
  const input: PhaseInput = {
    ...base,
    bumpBranches: nodesOf(repository.bumpRefs).map(bumpOf).filter((branch) => versionOfBumpBranch(branch.name) !== null),
    openReleasePr: prOf(nodesOf(repository.openReleasePr)[0]),
    lastClosedReleasePr: closedPrOf(nodesOf(repository.closedReleasePr)[0]),
    publishedTags,
    integrationVersion: versionIn(repository.integrationFile),
    productionVersion: versionIn(repository.productionFile),
  }

  const phase = resolvePhase(input)
  const sinceTag = releases[0]?.tagName ?? null
  let entries: readonly ReleaseEntry[] = []
  let note: string | null = null
  if (GATHERING.has(phase.kind)) {
    const since = tagged[0] === undefined ? null : (tagged[0].taggedAt ?? tagged[0].release.publishedAt)
    const until = phase.kind === 'ready-to-publish' ? str(obj(obj(repository.productionHead)?.target)?.committedDate) : null
    const read = await readMergedPrs({ github, repo, base: integration, since, until })
    if (!read.ok) return failure(read.message, readAt)
    entries = read.entries
    note = read.note
  }
  const resolved = phase.kind === 'idle' && entries.length === 0 ? resolvePhase({ ...input, gatherEmpty: true }) : phase

  const latestTag = releases.map((release) => normalizeVersion(release.tagName)).find((version) => version !== null) ?? null
  const fallback = input.integrationVersion === null ? null : stripPrerelease(input.integrationVersion)
  const currentVersion = latestTag ?? (parseVersion(fallback ?? '') === null ? null : fallback)

  const status: ReleaseStatus = {
    phase: resolved,
    versionSource: config.versionSource,
    production,
    integration,
    currentVersion,
    sinceTag,
    entries,
    truncatedNote: note,
    releases,
    productionHead: headOf(repository.productionHead)?.oid ?? null,
    postPublishHook: config.postPublishHook,
    readAt,
  }
  const viewer = (body.errors ?? []).some((error) => error.path?.[0] === 'viewer') ? null : str(obj(body.data?.viewer)?.login)
  return { ok: true, status, integrationHead, viewer: viewer === '' ? null : viewer }
}

/** One version file's text at a commit, read raw — never from the operator's checkout. */
export async function readFileAtRef(params: { readonly repo: GitHubRepoRef; readonly path: string; readonly ref: string; readonly github?: GitHubTransport }): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }> {
  const github = params.github ?? githubHttp
  const result = await github(restRequest(`repos/${params.repo.owner}/${params.repo.name}/contents/${params.path}?ref=${params.ref}`, RAW_ACCEPT))
  return result.ok ? { ok: true, text: result.body } : { ok: false, message: describeHttp(result) }
}

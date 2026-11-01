// fetchReleaseStatus: the state read, the commit gather and ticket resolution behind the Releases screen. Reads fail toward showing less with a note, except where a partial read would enable a write.
import { gh as defaultGh } from '@/main/platform/gh'
import type { GhResult, GhRunner } from '@/types/platform'
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
import { classifyFailure, parseEnvelope, stdoutOf } from '@/main/github/envelope'
import { STATE_ALIASES, buildStateQuery, buildTicketsQuery, stateVariables } from '@/main/github/release-query'
import { entriesFromCommits, ticketNumbersOf } from '@/utils/release/changelog'
import type { ChangelogCommit, ResolvedTicket } from '@/utils/release/changelog'
import { BUMP_BRANCH_PREFIX } from '@/utils/release/format'
import { resolvePhase } from '@/main/release/state'
import { buildCandidates, normalizeVersion, parseVersion, stripPrerelease } from '@/utils/release/version'

const COMMIT_PAGE = 100
const TICKET_CAP = 100
const SAFE_REF = /^[A-Za-z0-9._/-]+$/

type Obj = Readonly<Record<string, unknown>>

function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nodesOf(value: unknown): readonly Obj[] {
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

function releaseOf(node: Obj): ReleaseInfo | null {
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
  return { name: `${BUMP_BRANCH_PREFIX}${str(node.name) ?? ''}`, pr: typeof number === 'number' && url !== null ? { number, url } : null }
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

interface Gathered {
  readonly entries: readonly ReleaseEntry[]
  readonly note: string | null
}

type CommitRead = { readonly ok: true; readonly commits: readonly ChangelogCommit[]; readonly note: string | null } | { readonly ok: false; readonly message: string }

// A commit's subject is the first line of its message; its parent count tells a merge from a squash.
function commitsFrom(list: unknown): readonly ChangelogCommit[] | null {
  if (!Array.isArray(list)) return null
  return list.flatMap((item) => {
    const commit = obj(item)
    const message = str(obj(commit?.commit)?.message)
    if (commit === null || message === null) return []
    return [{ subject: message.split('\n')[0] ?? '', parents: Array.isArray(commit.parents) ? commit.parents.length : 1 }]
  })
}

function parseBody(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

// Newest first, matching the commits endpoint; the oldest-first compare list is reversed by its caller.
async function readLog(runner: GhRunner, repo: GitHubRepoRef, head: string): Promise<CommitRead> {
  const result = await runner(['api', `repos/${repo.owner}/${repo.name}/commits?sha=${head}&per_page=${String(COMMIT_PAGE)}`])
  if (!result.ok) return { ok: false, message: describe(result) }
  const commits = commitsFrom(parseBody(result.stdout))
  if (commits === null) return { ok: false, message: "GitHub's commit list wasn't JSON" }
  return { ok: true, commits, note: commits.length >= COMMIT_PAGE ? `Showing the latest ${String(COMMIT_PAGE)} commits.` : null }
}

async function readCompare(runner: GhRunner, repo: GitHubRepoRef, base: string, head: string): Promise<CommitRead> {
  const result = await runner(['api', `repos/${repo.owner}/${repo.name}/compare/${base}...${head}?per_page=${String(COMMIT_PAGE)}`])
  if (!result.ok) return { ok: false, message: describe(result) }
  const body = obj(parseBody(result.stdout))
  const commits = commitsFrom(body?.commits)
  if (body === null || commits === null) return { ok: false, message: "GitHub's comparison wasn't JSON" }
  if (body.status === 'diverged') return readLog(runner, repo, head)
  const total = typeof body.total_commits === 'number' ? body.total_commits : commits.length
  const note = total > commits.length ? `Showing the first ${String(commits.length)} commits since ${base}.` : null
  return { ok: true, commits: [...commits].reverse(), note }
}

async function resolveTickets(runner: GhRunner, repo: GitHubRepoRef, numbers: readonly number[]): Promise<{ readonly tickets: ReadonlyMap<number, ResolvedTicket>; readonly note: string | null }> {
  if (numbers.length === 0) return { tickets: new Map(), note: null }
  const result = await runner(['api', 'graphql', '-f', `query=${buildTicketsQuery(numbers)}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`])
  const stdout = stdoutOf(result)
  const parsed = stdout === undefined ? undefined : parseEnvelope(stdout)
  const verdict = classifyFailure(result, parsed)
  const repository = parsed?.ok === true ? obj(parsed.value.data?.repository) : null
  if (verdict.kind !== 'ok' || repository === null) return { tickets: new Map(), note: "Ticket titles and labels couldn't be read, so changes show their commit subjects." }
  const tickets = new Map<number, ResolvedTicket>()
  for (const number of numbers) {
    const node = obj(repository[`t${String(number)}`])
    const title = str(node?.title)
    if (node === null || title === null) continue
    tickets.set(number, {
      title,
      labels: nodesOf(node.labels).flatMap((label) => str(label.name) ?? []),
      bot: str(obj(node.author)?.__typename) === 'Bot',
    })
  }
  return { tickets, note: null }
}

interface GatherParams {
  readonly runner: GhRunner
  readonly repo: GitHubRepoRef
  readonly integration: string
  readonly production: string
  readonly previousTag: string | null
  readonly publishing: boolean
}

async function gather(params: GatherParams): Promise<{ readonly ok: true; readonly gathered: Gathered } | { readonly ok: false; readonly message: string }> {
  const { runner, repo, previousTag } = params
  const head = params.publishing ? params.production : params.integration
  let read: CommitRead
  if (previousTag !== null) read = await readCompare(runner, repo, previousTag, head)
  else if (params.publishing) read = await readLog(runner, repo, head)
  else read = await readCompare(runner, repo, params.production, params.integration)
  if (!read.ok) return { ok: false, message: `Couldn't read the changes: ${read.message}` }

  const all = [...new Set(read.commits.filter((commit) => commit.parents <= 1).flatMap((commit) => ticketNumbersOf(commit.subject)))]
  const numbers = all.slice(0, TICKET_CAP)
  const { tickets, note: ticketNote } = await resolveTickets(runner, repo, numbers)
  const capNote = all.length > TICKET_CAP ? `Resolved the newest ${String(TICKET_CAP)} of ${String(all.length)} tickets.` : null
  const note = [read.note, capNote, ticketNote].filter((part): part is string => part !== null).join(' ')
  return { ok: true, gathered: { entries: entriesFromCommits(read.commits, tickets), note: note === '' ? null : note } }
}

export interface FetchReleaseStatusParams {
  readonly repo: GitHubRepoRef
  readonly integration: string
  readonly production: string | null
  readonly moduleEnabled: boolean
  readonly config: ReleaseConfig
  readonly gh?: GhRunner
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
    candidates: [],
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
  const runner = params.gh ?? defaultGh
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
  const args = ['api', 'graphql', '-f', `query=${buildStateQuery(versionFile !== null)}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`]
  for (const [key, value] of Object.entries(stateVariables({ integration, production, versionFile }))) args.push('-f', `${key}=${value}`)

  const result = await runner(args)
  const stdout = stdoutOf(result)
  const parsed = stdout === undefined ? undefined : parseEnvelope(stdout)
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

  const allReleases = nodesOf(repository.releases)
  const releases = allReleases.flatMap((node) => releaseOf(node) ?? [])
  const publishedTags = new Set(releases.map((release) => release.tagName))
  const integrationHead = headOf(repository.integrationHead)
  const input: PhaseInput = {
    ...base,
    bumpBranches: nodesOf(repository.bumpRefs).map(bumpOf),
    openReleasePr: prOf(nodesOf(repository.openReleasePr)[0]),
    lastClosedReleasePr: closedPrOf(nodesOf(repository.closedReleasePr)[0]),
    publishedTags,
    integrationVersion: versionIn(repository.integrationFile),
    productionVersion: versionIn(repository.productionFile),
  }

  const phase = resolvePhase(input)
  const previousTag = releases[0]?.tagName ?? null
  let gathered: Gathered = { entries: [], note: null }
  if (GATHERING.has(phase.kind)) {
    const read = await gather({ runner, repo, integration, production, previousTag, publishing: phase.kind === 'ready-to-publish' })
    if (!read.ok) return failure(read.message, readAt)
    gathered = read.gathered
  }
  const resolved = phase.kind === 'idle' && gathered.entries.length === 0 ? resolvePhase({ ...input, gatherEmpty: true }) : phase

  const latestTag = releases.map((release) => normalizeVersion(release.tagName)).find((version) => version !== null) ?? null
  const fallback = input.integrationVersion === null ? null : stripPrerelease(input.integrationVersion)
  const currentVersion = latestTag ?? (parseVersion(fallback ?? '') === null ? null : fallback)

  const status: ReleaseStatus = {
    phase: resolved,
    versionSource: config.versionSource,
    production,
    integration,
    currentVersion,
    candidates: resolved.kind === 'idle' ? buildCandidates(currentVersion ?? '0.0.0', gathered.entries) : [],
    entries: gathered.entries,
    truncatedNote: gathered.note,
    releases,
    productionHead: headOf(repository.productionHead)?.oid ?? null,
    postPublishHook: config.postPublishHook,
    readAt,
  }
  const viewer = (body.errors ?? []).some((error) => error.path?.[0] === 'viewer') ? null : str(obj(body.data?.viewer)?.login)
  return { ok: true, status, integrationHead, viewer: viewer === '' ? null : viewer }
}

/** One version file's text at a commit, read raw — never from the operator's checkout. */
export async function readFileAtRef(params: { readonly repo: GitHubRepoRef; readonly path: string; readonly ref: string; readonly gh?: GhRunner }): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }> {
  const runner = params.gh ?? defaultGh
  const result = await runner(['api', `repos/${params.repo.owner}/${params.repo.name}/contents/${params.path}?ref=${params.ref}`, '-H', 'Accept: application/vnd.github.raw'])
  return result.ok ? { ok: true, text: result.stdout } : { ok: false, message: describe(result) }
}

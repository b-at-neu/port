// The one composition report, reclaim and purge share: enumerate, gather facts, resolve item states, classify.
import { readItemStates } from '@/main/github/item-states'
import { readWorktrees } from '@/main/local/worktrees'
import { listDirectory, pathExists, readTextFile, removeDirectory, statPath } from '@/main/platform/files'
import { defaultGitRunner } from '@/main/platform/git'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import type { AssertEqual } from '@/types/assert-type'
import type { ItemStateName } from '@/types/github'
import type { WorktreeEntry } from '@/types/local'
import type { CommandResult, GitRunner } from '@/types/platform'
import type { InspectedCandidate, Inspection, ReadWorktreeReportParams, ReclaimerFailureKind, ReclaimerFs, ReclaimerSeams, ResolvedSeams } from '@/types/reclaimer'
import { classifyCandidate, describeReason } from '@/main/reclaimer/classify'
import { findOrphanDirs } from '@/main/reclaimer/orphans'

// Fails to compile if a new `CommandResult` failure kind is added without `ReclaimerFailureKind` growing to match.
type CommandResultFailureKind = Exclude<CommandResult, { ok: true }>['kind']
type ReclaimerOwnFailureKind = 'not-a-repository' | 'no-integration-ref' | 'path-not-registered' | 'github-unavailable'
export const _kindsCoverCommandResult: AssertEqual<ReclaimerFailureKind, CommandResultFailureKind | ReclaimerOwnFailureKind> = true

const defaultFs: ReclaimerFs = { listDirectory, statPath, readTextFile, pathExists, removeDirectory }

/** Every git call runs with `core.longpaths` on, which Windows needs and other platforms ignore. */
export function resolveSeams(seams: ReclaimerSeams): ResolvedSeams {
  const base = seams.git ?? defaultGitRunner()
  return {
    git: (args, cwd) => base(['-c', 'core.longpaths=true', ...args], cwd),
    fs: seams.fs ?? defaultFs,
    pathOps: seams.pathOps ?? defaultPathOps,
    now: seams.now ?? (() => new Date()),
  }
}

export interface InspectParams extends ReadWorktreeReportParams {
  readonly unlock: boolean
  readonly forceDirty: boolean
}

async function gitStdout(git: GitRunner, args: readonly string[], cwd: string): Promise<string | null> {
  const result = await git(args, cwd)
  return result.ok ? result.stdout.trim() : null
}

/** Never fetches — a stale ref only makes `no-work` under-report, the safe direction. */
async function resolveIntegrationRef(git: GitRunner, mainPath: string, integration: string): Promise<string | null> {
  if ((await gitStdout(git, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${integration}`], mainPath)) !== null) return `origin/${integration}`
  if ((await gitStdout(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`], mainPath)) !== null) return integration
  return null
}

/** A failed status counts as dirty, never clean — the one check whose point is never discarding uncommitted work. */
async function countDirtyFiles(git: GitRunner, path: string): Promise<number> {
  const result = await git(['status', '--porcelain'], path)
  if (!result.ok) return -1
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length
}

interface Facts {
  readonly git: GitRunner
  readonly mainPath: string
  readonly integrationRef: string
  readonly states: ReadonlyMap<number, ItemStateName | null>
  readonly unlock: boolean
  readonly forceDirty: boolean
}

async function inspectEntry(entry: WorktreeEntry, isOutside: boolean, facts: Facts): Promise<InspectedCandidate> {
  const correlation = isOutside ? null : entry.correlation
  const itemState = correlation === null ? null : (facts.states.get(correlation.number) ?? null)

  if (isOutside) {
    const classified = classifyCandidate({ isOutside: true, isProtected: false, locked: false, dirty: false, itemState: null, isAncestor: null })
    const reason = describeReason({ state: classified.state, path: entry.path, itemState: null, correlation: null, lockReason: null, otherwiseRemovable: false, dirtyFiles: 0 })
    return { entry, correlation: null, itemState: null, dirtyFiles: 0, state: classified.state, removable: false, otherwiseReclaimable: false, reason }
  }

  // An error counts as not an ancestor, which fails toward `unresolved`.
  let isAncestor: boolean | null = null
  if (correlation === null && entry.head !== null) {
    isAncestor = (await facts.git(['merge-base', '--is-ancestor', entry.head, facts.integrationRef], facts.mainPath)).ok
  }

  const base = classifyCandidate({ isOutside: false, isProtected: false, locked: false, dirty: false, itemState, isAncestor })
  const dirtyFiles = base.removable || entry.locked ? await countDirtyFiles(facts.git, entry.path) : 0
  const classified = classifyCandidate({
    isOutside: false,
    isProtected: false,
    locked: entry.locked && !facts.unlock,
    dirty: dirtyFiles !== 0 && !facts.forceDirty,
    itemState,
    isAncestor,
  })
  const reason = describeReason({
    state: classified.state,
    path: entry.path,
    itemState,
    correlation,
    lockReason: entry.lockReason,
    otherwiseRemovable: classified.otherwiseRemovable,
    dirtyFiles,
  })
  return { entry, correlation, itemState, dirtyFiles, state: classified.state, removable: classified.removable, otherwiseReclaimable: classified.otherwiseRemovable, reason }
}

/** Reads every linked worktree and decides what each is. A GitHub failure still returns `ok`, with `githubError` set and every item state unknown. */
export async function inspectWorktrees(params: InspectParams): Promise<Inspection> {
  const { git, fs, pathOps, now } = resolveSeams(params)

  const read = await readWorktrees({ repoRoot: params.repoRoot, git, pathOps, now })
  if (!read.ok) return { ok: false, kind: read.kind, message: read.message }
  const mainPath = read.mainPath

  const integrationRef = await resolveIntegrationRef(git, mainPath, params.integration)
  if (integrationRef === null) {
    const message = `Neither origin/${params.integration} nor a local ${params.integration} branch exists, so finished worktrees can't be identified.`
    return { ok: false, kind: 'no-integration-ref', message, integration: params.integration }
  }

  const linked = read.entries.filter((entry) => !entry.isMain).map((entry) => ({ entry, isOutside: !entry.insideMain }))

  const numbers = [...new Set(linked.flatMap(({ entry, isOutside }) => (isOutside || entry.correlation === null ? [] : [entry.correlation.number])))]
  const [owner = '', name = ''] = params.repo.split('/')
  const stateRead = await readItemStates({ repo: { owner, name }, numbers, gh: params.gh })
  const states: ReadonlyMap<number, ItemStateName | null> = stateRead.ok ? stateRead.states : new Map()
  const githubError = stateRead.ok ? null : stateRead.message

  const facts: Facts = { git, mainPath, integrationRef, states, unlock: params.unlock, forceDirty: params.forceDirty }
  const candidates = await Promise.all(linked.map(({ entry, isOutside }) => inspectEntry(entry, isOutside, facts)))
  const orphanDirs = await findOrphanDirs(mainPath, linked.map(({ entry, isOutside }) => ({ path: entry.path, isOutside })), fs, pathOps)

  return { ok: true, mainPath, integrationRef, candidates, orphanDirs, githubError }
}

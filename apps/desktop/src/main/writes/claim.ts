// readGateClaim / takeGateClaim / releaseGateClaim over
// `<base repo root>/.agents/gate-claim.json` (docs/COORDINATION.md → "The
// claim contract"), resolving the base root with the same
// `git rev-parse --git-common-dir` helper `main/local/denials.ts` already
// uses, so every worktree of a checkout sees the one claim. Reads `scopes`
// and never `owner` as anything but report-only text — treating it as
// identity would make it the liveness field the doc forbids.
import { ensureDirectory, git as defaultGit, pathOps as defaultPathOps, readJsonFile, removeFile, writeJsonFileAtomic } from '../platform'
import type { CommandResult, FileFailureKind, PathOps } from '../platform'
import type { AssertEqual } from '../../shared/assert-type'
import type { ClaimRead, ClaimScope, ClaimWriteFailureKind, ClaimWriteResult } from '../../shared/writes/types'

/** The same seam `main/local/denials.ts` declares — a `git` invocation is
 *  needed here only to resolve the base repository root, never to read or
 *  write the claim's own content. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

/** Fails to compile if the platform layer's `FileFailureKind` changes
 *  without `ClaimWriteFailureKind` (`shared/writes/types.ts`) growing to
 *  match — the same pin `main/local/denials.ts` establishes for
 *  `DenialsFailureKind`. A claim write can report every kind except
 *  `unparseable`, which only a JSON *read* can produce. */
type FileFailureKindExcludingUnparseable = Exclude<FileFailureKind, 'unparseable'>
export const _kindsCoverFileFailureKind: AssertEqual<ClaimWriteFailureKind, FileFailureKindExcludingUnparseable> = true

const RECOGNIZED_SCOPES: ReadonlySet<string> = new Set<ClaimScope>(['plan-gate'])

interface ClaimFileShape {
  readonly repo?: unknown
  readonly owner?: unknown
  readonly scopes?: unknown
  readonly claimedAt?: unknown
}

/** Identical in shape to `main/local/denials.ts`'s own `resolveBaseRoot` —
 *  duplicated rather than shared, since neither directory imports from the
 *  other and each is a single-purpose adapter. Degrades to `repoRoot` on any
 *  failure — the common case is a plain checkout where the two are
 *  identical. */
async function resolveBaseRoot(git: GitRunner, repoRoot: string, pathOps: PathOps): Promise<string> {
  const result = await git(['rev-parse', '--git-common-dir'], repoRoot)
  if (!result.ok) return repoRoot
  const common = result.stdout.trim()
  if (common === '') return repoRoot
  try {
    return pathOps.dirname(pathOps.resolveFrom(repoRoot, common))
  } catch {
    return repoRoot
  }
}

function defaultGitRunner(): GitRunner {
  return (args, cwd) => defaultGit(args, { cwd })
}

interface ClaimDeps {
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

async function resolveClaimPath(deps: ClaimDeps): Promise<string> {
  const pathOps = deps.pathOps ?? defaultPathOps
  const git = deps.git ?? defaultGitRunner()
  const baseRoot = await resolveBaseRoot(git, deps.repoRoot, pathOps)
  return pathOps.join(baseRoot, '.agents', 'gate-claim.json')
}

function toScopes(raw: unknown): { scopes: ClaimScope[]; unknownScopes: string[] } {
  const scopes: ClaimScope[] = []
  const unknownScopes: string[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue
      if (RECOGNIZED_SCOPES.has(entry)) scopes.push(entry as ClaimScope)
      else unknownScopes.push(entry)
    }
  }
  return { scopes, unknownScopes }
}

export interface ReadGateClaimParams extends ClaimDeps {
  readonly repo: string
  readonly now?: () => Date
}

/** A malformed claim reads as `unreadable`, on both sides of the gate — the
 *  ambiguous case is which writer owns it, and standing both down is the
 *  only reading that cannot produce an unintended decision
 *  (`docs/COORDINATION.md` → "Failure directions"). A `repo` mismatch reads
 *  as `absent`, a positive determination rather than an unreadable one. */
export async function readGateClaim(params: ReadGateClaimParams): Promise<ClaimRead> {
  const now = params.now ?? (() => new Date())
  const readAt = now().toISOString()
  const path = await resolveClaimPath(params)

  const result = await readJsonFile<ClaimFileShape>(path)
  if (!result.ok) {
    if (result.kind === 'not-found') return { state: 'absent', path, readAt }
    return { state: 'unreadable', message: result.message, path, readAt }
  }

  const value = result.value
  if (typeof value !== 'object' || value === null) {
    return { state: 'unreadable', message: `${path} is not a JSON object`, path, readAt }
  }
  if (typeof value.repo !== 'string' || value.repo !== params.repo) {
    return { state: 'absent', path, readAt }
  }
  if (typeof value.owner !== 'string' || typeof value.claimedAt !== 'string') {
    return { state: 'unreadable', message: `${path} is missing 'owner' or 'claimedAt'`, path, readAt }
  }
  const { scopes, unknownScopes } = toScopes(value.scopes)

  return { state: 'held', owner: value.owner, scopes, unknownScopes, claimedAt: value.claimedAt, path, readAt }
}

function toClaimWriteFailureKind(kind: FileFailureKind): ClaimWriteFailureKind {
  return kind === 'unparseable' ? 'io' : kind
}

export interface TakeGateClaimParams extends ClaimDeps {
  readonly repo: string
  readonly owner: string
  readonly scopes: readonly ClaimScope[]
  readonly now?: () => Date
}

/** Created only by an explicit operator action in the app (#92 wires the
 *  button) — nothing here is called on any machine-observed condition. */
export async function takeGateClaim(params: TakeGateClaimParams): Promise<ClaimWriteResult> {
  const pathOps = params.pathOps ?? defaultPathOps
  const now = params.now ?? (() => new Date())
  const path = await resolveClaimPath(params)

  // `.agents/` may not exist yet — `writeJsonFileAtomic` writes its temp file
  // beside `path`, so the directory must exist first (the same order
  // `main/registry/store.ts`'s own `writeRegistry` follows).
  const ensured = await ensureDirectory(pathOps.dirname(path))
  if (!ensured.ok) return { ok: false, kind: toClaimWriteFailureKind(ensured.kind), message: ensured.message, path }

  const value = { repo: params.repo, owner: params.owner, scopes: params.scopes, claimedAt: now().toISOString() }
  const written = await writeJsonFileAtomic(path, value)
  if (!written.ok) return { ok: false, kind: toClaimWriteFailureKind(written.kind), message: written.message, path }
  return { ok: true, path }
}

export type ReleaseGateClaimParams = ClaimDeps

/** Released only by an explicit operator action or by deleting the file by
 *  hand — an already-absent claim is treated as success, since the caller's
 *  intent ("the claim should not exist") is already satisfied. */
export async function releaseGateClaim(params: ReleaseGateClaimParams): Promise<ClaimWriteResult> {
  const path = await resolveClaimPath(params)

  const removed = await removeFile(path)
  if (!removed.ok) {
    if (removed.kind === 'not-found') return { ok: true, path }
    return { ok: false, kind: toClaimWriteFailureKind(removed.kind), message: removed.message, path }
  }
  return { ok: true, path }
}

// readGateClaim / takeClaimScope / releaseClaimScope over
// `<base repo root>/.agents/gate-claim.json` (docs/COORDINATION.md → "The
// claim contract"), resolving the base root with the same
// `git rev-parse --git-common-dir` helper `main/local/denials.ts` already
// uses, so every worktree of a checkout sees the one claim. Reads `scopes`
// and never `owner` as anything but report-only text — treating it as
// identity would make it the liveness field the doc forbids.
import { defaultGitRunner, ensureDirectory, pathOps as defaultPathOps, readJsonFile, removeFile, resolveGitBaseRoot, writeJsonFileAtomic } from '../platform'
import type { FileFailureKind, GitRunner, PathOps } from '../platform'
import type { AssertEqual } from '../../shared/assert-type'
import type { ClaimRead, ClaimScope, ClaimWriteFailureKind, ClaimWriteResult } from '../../shared/writes/types'

export type { GitRunner }

/** Fails to compile if the platform layer's `FileFailureKind` changes
 *  without `ClaimWriteFailureKind` (`shared/writes/types.ts`) growing to
 *  match — the same pin `main/local/denials.ts` establishes for
 *  `DenialsFailureKind`. A claim write can report every kind except
 *  `unparseable`, which only a JSON *read* can produce. */
type FileFailureKindExcludingUnparseable = Exclude<FileFailureKind, 'unparseable'>
export const _kindsCoverFileFailureKind: AssertEqual<ClaimWriteFailureKind, FileFailureKindExcludingUnparseable> = true

const RECOGNIZED_SCOPES: ReadonlySet<string> = new Set<ClaimScope>(['plan-gate', 'dispatch'])

interface ClaimFileShape {
  readonly repo?: unknown
  readonly owner?: unknown
  readonly scopes?: unknown
  readonly claimedAt?: unknown
}

interface ClaimDeps {
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

async function resolveClaimPath(deps: ClaimDeps): Promise<string> {
  const pathOps = deps.pathOps ?? defaultPathOps
  const git = deps.git ?? defaultGitRunner()
  const baseRoot = await resolveGitBaseRoot(git, deps.repoRoot, pathOps)
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

export interface TakeClaimScopeParams extends ClaimDeps {
  readonly repo: string
  readonly owner: string
  readonly scope: ClaimScope
  readonly now?: () => Date
}

/**
 * Read-modify-write, atomically: adds `scope` to whatever the file already
 * holds, keeping every other scope — recognized or not — and the existing
 * `claimedAt`, verbatim (so taking `dispatch` can never drop a held
 * `plan-gate`, or vice versa). A new or repo-mismatched file starts fresh at
 * `now()`. An unreadable file is overwritten with the one requested scope,
 * discarding whatever malformed content was there — today's behaviour from
 * before a second scope existed, now stated explicitly rather than merely
 * implied by there being nothing else to preserve.
 *
 * Created only by an explicit operator action in the app (#92/#265 wire the
 * buttons) — nothing here is called on any machine-observed condition.
 */
export async function takeClaimScope(params: TakeClaimScopeParams): Promise<ClaimWriteResult> {
  const pathOps = params.pathOps ?? defaultPathOps
  const now = params.now ?? (() => new Date())
  const path = await resolveClaimPath(params)

  // `.agents/` may not exist yet — `writeJsonFileAtomic` writes its temp file
  // beside `path`, so the directory must exist first (the same order
  // `main/registry/store.ts`'s own `writeRegistry` follows).
  const ensured = await ensureDirectory(pathOps.dirname(path))
  if (!ensured.ok) return { ok: false, kind: toClaimWriteFailureKind(ensured.kind), message: ensured.message, path }

  const current = await readGateClaim(params)
  let scopes: string[]
  let claimedAt: string
  if (current.state === 'held') {
    scopes = [...current.scopes, ...current.unknownScopes]
    claimedAt = current.claimedAt
  } else {
    scopes = []
    claimedAt = now().toISOString()
  }
  if (!scopes.includes(params.scope)) scopes = [...scopes, params.scope]

  const value = { repo: params.repo, owner: params.owner, scopes, claimedAt }
  const written = await writeJsonFileAtomic(path, value)
  if (!written.ok) return { ok: false, kind: toClaimWriteFailureKind(written.kind), message: written.message, path }
  return { ok: true, path }
}

export interface ReleaseClaimScopeParams extends ClaimDeps {
  readonly repo: string
  readonly scope: ClaimScope
}

/**
 * Read-modify-write: removes `scope`, keeping every other scope —
 * recognized or not — verbatim, and deletes the file once none remain.
 * Released only by an explicit operator action or by deleting the file by
 * hand — an already-absent claim is treated as success, since the caller's
 * intent ("the claim should not exist") is already satisfied. An unreadable
 * file is deleted outright regardless of `scope`, the same "both today's
 * behaviour" carve-out `takeClaimScope` documents.
 */
export async function releaseClaimScope(params: ReleaseClaimScopeParams): Promise<ClaimWriteResult> {
  const path = await resolveClaimPath(params)
  const current = await readGateClaim(params)

  if (current.state === 'absent') return { ok: true, path }
  if (current.state === 'unreadable') {
    const removed = await removeFile(path)
    if (!removed.ok && removed.kind !== 'not-found') return { ok: false, kind: toClaimWriteFailureKind(removed.kind), message: removed.message, path }
    return { ok: true, path }
  }

  const remaining = [...current.scopes, ...current.unknownScopes].filter((s) => s !== params.scope)
  if (remaining.length === 0) {
    const removed = await removeFile(path)
    if (!removed.ok && removed.kind !== 'not-found') return { ok: false, kind: toClaimWriteFailureKind(removed.kind), message: removed.message, path }
    return { ok: true, path }
  }

  const value = { repo: params.repo, owner: current.owner, scopes: remaining, claimedAt: current.claimedAt }
  const written = await writeJsonFileAtomic(path, value)
  if (!written.ok) return { ok: false, kind: toClaimWriteFailureKind(written.kind), message: written.message, path }
  return { ok: true, path }
}

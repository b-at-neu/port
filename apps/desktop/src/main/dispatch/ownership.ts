// readOwnership / takeOwnership / releaseOwnership over `<base repo root>/.agents/cockpit.json`,
// resolving the base root the same way every worktree of a checkout sees the one record.
import { defaultGitRunner, resolveGitBaseRoot } from '../platform/git'
import { ensureDirectory, readTextFile, removeFile, writeJsonFileAtomic } from '../platform/files'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { FileFailureKind } from '../platform/files'
import type { GitRunner } from '../platform/git'
import type { PathOps } from '../platform/paths'
import type { OwnershipSummary } from '../../shared/writes/types'

export type { GitRunner }

export type OwnershipOwner = 'app' | 'terminal'

export interface OwnershipRecord {
  readonly repo: string
  readonly owner: OwnershipOwner
  readonly since: string
}

interface OwnershipFileShape {
  readonly repo?: unknown
  readonly owner?: unknown
  readonly since?: unknown
}

/** The classification alone, with no path or clock — a `repo` mismatch reads as `absent`
 *  (a positive determination), and anything else untrustworthy reads as `unreadable`. */
export function classifyOwnership(exists: boolean, text: string | null, repo: string): OwnershipVerdict {
  if (!exists || text === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unreadable', message: 'cockpit.json is not a JSON object' }
  }
  const value = parsed as OwnershipFileShape
  if (typeof value.repo !== 'string' || value.repo !== repo) return { kind: 'absent' }
  if (typeof value.since !== 'string') return { kind: 'unreadable', message: "cockpit.json is missing 'since'" }
  if (value.owner === 'app') return { kind: 'app', since: value.since }
  if (value.owner === 'terminal') return { kind: 'terminal', since: value.since }
  return { kind: 'unreadable', message: "cockpit.json has an unknown 'owner'" }
}

export type OwnershipVerdict =
  | { readonly kind: 'absent' }
  | { readonly kind: 'app'; readonly since: string }
  | { readonly kind: 'terminal'; readonly since: string }
  | { readonly kind: 'unreadable'; readonly message: string }

interface OwnershipDeps {
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

async function resolveOwnershipPath(deps: OwnershipDeps): Promise<string> {
  const pathOps = deps.pathOps ?? defaultPathOps
  const git = deps.git ?? defaultGitRunner()
  const baseRoot = await resolveGitBaseRoot(git, deps.repoRoot, pathOps)
  return pathOps.join(baseRoot, '.agents', 'cockpit.json')
}

export type OwnershipRead =
  | { readonly kind: 'absent'; readonly path: string; readonly readAt: string }
  | { readonly kind: 'app'; readonly since: string; readonly path: string; readonly readAt: string }
  | { readonly kind: 'terminal'; readonly since: string; readonly path: string; readonly readAt: string }
  | { readonly kind: 'unreadable'; readonly message: string; readonly path: string; readonly readAt: string }

export interface ReadOwnershipParams extends OwnershipDeps {
  readonly repo: string
  readonly now?: () => Date
}

export async function readOwnership(params: ReadOwnershipParams): Promise<OwnershipRead> {
  const now = params.now ?? (() => new Date())
  const readAt = now().toISOString()
  const path = await resolveOwnershipPath(params)

  const result = await readTextFile(path)
  if (!result.ok) {
    if (result.kind === 'not-found') return { kind: 'absent', path, readAt }
    return { kind: 'unreadable', message: result.message, path, readAt }
  }

  const verdict = classifyOwnership(true, result.value, params.repo)
  switch (verdict.kind) {
    case 'absent':
      return { kind: 'absent', path, readAt }
    case 'app':
      return { kind: 'app', since: verdict.since, path, readAt }
    case 'terminal':
      return { kind: 'terminal', since: verdict.since, path, readAt }
    case 'unreadable':
      return { kind: 'unreadable', message: verdict.message, path, readAt }
  }
}

/** Drops the path/clock fields — the renderer-safe shape every gate and dispatch surface renders. */
export function toOwnershipSummary(read: OwnershipRead): OwnershipSummary {
  switch (read.kind) {
    case 'absent':
      return { kind: 'absent' }
    case 'app':
      return { kind: 'app', since: read.since }
    case 'terminal':
      return { kind: 'terminal', since: read.since }
    case 'unreadable':
      return { kind: 'unreadable', path: read.path, message: read.message }
  }
}

type OwnershipWriteFailureKind = Exclude<FileFailureKind, 'unparseable'>

function toOwnershipWriteFailureKind(kind: FileFailureKind): OwnershipWriteFailureKind {
  return kind === 'unparseable' ? 'io' : kind
}

export type OwnershipWriteResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly kind: OwnershipWriteFailureKind; readonly message: string; readonly path: string }

export interface TakeOwnershipParams extends OwnershipDeps {
  readonly repo: string
  /** Overwrites a `terminal` record — reached only from the confirmed Take over dialog. */
  readonly force?: boolean
  readonly now?: () => Date
}

export type TakeOwnershipResult = OwnershipWriteResult | { readonly ok: false; readonly kind: 'refused'; readonly verdict: Extract<OwnershipRead, { kind: 'terminal' | 'unreadable' }>; readonly path: string }

/** Always writes `owner: "app"`, the only owner this process ever claims for itself — no
 *  read-modify-write, since a record carries exactly one owner and `since` always starts fresh. */
export async function takeOwnership(params: TakeOwnershipParams): Promise<TakeOwnershipResult> {
  const pathOps = params.pathOps ?? defaultPathOps
  const now = params.now ?? (() => new Date())
  const path = await resolveOwnershipPath(params)

  const current = await readOwnership(params)
  if (!params.force && (current.kind === 'terminal' || current.kind === 'unreadable')) {
    return { ok: false, kind: 'refused', verdict: current, path }
  }

  const ensured = await ensureDirectory(pathOps.dirname(path))
  if (!ensured.ok) return { ok: false, kind: toOwnershipWriteFailureKind(ensured.kind), message: ensured.message, path }

  const value: OwnershipRecord = { repo: params.repo, owner: 'app', since: now().toISOString() }
  const written = await writeJsonFileAtomic(path, value)
  if (!written.ok) return { ok: false, kind: toOwnershipWriteFailureKind(written.kind), message: written.message, path }
  return { ok: true, path }
}

export interface ReleaseOwnershipParams extends OwnershipDeps {
  readonly repo: string
}

/** Deletes the record only when the verdict is `app` — never a `terminal`/`unreadable` one,
 *  the rail that keeps a release from ever discarding a cockpit it does not own. */
export async function releaseOwnership(params: ReleaseOwnershipParams): Promise<OwnershipWriteResult> {
  const path = await resolveOwnershipPath(params)
  const current = await readOwnership(params)
  if (current.kind !== 'app') return { ok: true, path }

  const removed = await removeFile(path)
  if (!removed.ok && removed.kind !== 'not-found') return { ok: false, kind: toOwnershipWriteFailureKind(removed.kind), message: removed.message, path }
  return { ok: true, path }
}

// Resolves a `session:start` target to a cwd/workspace/repoId, creating a session worktree only on
// an explicit `worktree: true` — the only place a start target becomes a cwd.
import type { GitRunner } from '../platform/git'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { PathOps } from '../platform/paths'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { SessionStartMode, SessionStartResult, SessionStartTarget } from '../../shared/hosting/types'
import type { SessionWorkspace } from '../../shared/workspace/types'
import { isReadyEntry } from '../registry'
import type { RecentsStore } from './recents'
import type { CreateSessionWorktreeParams, CreateSessionWorktreeResult } from './worktree'
import { resolveWorkspace, toFolderId } from './resolve'
import type { SessionReader } from '../sessions/sdk'

export type ResolvedStartTarget =
  | {
      readonly ok: true
      readonly cwd: string
      readonly workspace: SessionWorkspace
      readonly repoId: RepoId | null
      /** The worktree this resolution created, so a failed `store.start` can remove it again. */
      readonly createdWorktree: { readonly path: string } | null
      /** The folder path to record in recents on a successful start — `null` for a transcript target. */
      readonly recordPath: string | null
    }
  | Exclude<SessionStartResult, { readonly ok: true } | { readonly ok: false; readonly kind: 'at-capacity' | 'runtime' | 'already-open' | 'folder-busy' }>

export interface ResolveStartTargetDeps {
  readonly git: GitRunner
  readonly repositories: readonly RepositoryEntry[]
  readonly recents: RecentsStore
  readonly exists: (path: string) => Promise<boolean>
  readonly readSessions: SessionReader
  readonly createWorktree: (params: CreateSessionWorktreeParams) => Promise<CreateSessionWorktreeResult>
  readonly pathOps?: PathOps
}

function sessionIdOf(mode: SessionStartMode): string | null {
  return mode.kind === 'resume' || mode.kind === 'resume-at' || mode.kind === 'fork' ? mode.sessionId : null
}

async function resolveFolderPath(folderId: string, deps: ResolveStartTargetDeps, ops: PathOps): Promise<string> {
  const readyPaths = deps.repositories.filter(isReadyEntry).map((entry) => entry.path)
  const recents = await deps.recents.load()
  const candidates = [...readyPaths, ...recents.map((entry) => entry.path)]
  const found = candidates.find((path) => toFolderId(ops.pathKey(path)) === folderId)
  if (found === undefined) throw new Error(`'session:start' found no folder registered with id '${folderId}'`)
  return found
}

async function resolveTranscriptCwd(mode: SessionStartMode, deps: ResolveStartTargetDeps): Promise<{ readonly ok: true; readonly cwd: string } | { readonly ok: false; readonly kind: 'folder-missing'; readonly path: string | null }> {
  const sessionId = sessionIdOf(mode)
  if (sessionId === null) throw new Error("'session:start' requires a transcript target's mode to carry a sessionId")

  const listed = await deps.readSessions()
  if (!listed.ok) throw new Error(`'session:start' could not list sessions for a transcript target: ${listed.message}`)

  const session = listed.sessions.find((candidate) => candidate.sessionId === sessionId)
  if (session === undefined || session.cwd === null) return { ok: false, kind: 'folder-missing', path: null }

  if (!(await deps.exists(session.cwd))) return { ok: false, kind: 'folder-missing', path: session.cwd }
  return { ok: true, cwd: session.cwd }
}

/** Resolves one `session:start` target into `{ cwd, workspace, repoId }`, creating a worktree when
 *  the target asks for one. An unknown `folderId` throws — a stale renderer, never a typed result. */
export async function resolveStartTarget(target: SessionStartTarget, mode: SessionStartMode, deps: ResolveStartTargetDeps): Promise<ResolvedStartTarget> {
  const ops = deps.pathOps ?? defaultPathOps

  if (target.kind === 'transcript') {
    const resolved = await resolveTranscriptCwd(mode, deps)
    if (!resolved.ok) return resolved
    const { workspace, repoId } = await resolveWorkspace(resolved.cwd, { git: deps.git, repositories: deps.repositories, pathOps: ops })
    return { ok: true, cwd: workspace.folder, workspace, repoId, createdWorktree: null, recordPath: null }
  }

  const path = await resolveFolderPath(target.folderId, deps, ops)
  if (!(await deps.exists(path))) return { ok: false, kind: 'folder-missing', path }

  const resolved = await resolveWorkspace(path, { git: deps.git, repositories: deps.repositories, pathOps: ops })

  if (!target.worktree) {
    return { ok: true, cwd: resolved.workspace.folder, workspace: resolved.workspace, repoId: resolved.repoId, createdWorktree: null, recordPath: path }
  }

  if (resolved.workspace.root === null) return { ok: false, kind: 'not-git' }

  const created = await deps.createWorktree({ root: resolved.workspace.root, git: deps.git, pathOps: ops })
  if (!created.ok) return { ok: false, kind: 'worktree-failed', message: created.message }

  const worktreeResolved = await resolveWorkspace(created.path, { git: deps.git, repositories: deps.repositories, pathOps: ops })
  return { ok: true, cwd: worktreeResolved.workspace.folder, workspace: worktreeResolved.workspace, repoId: worktreeResolved.repoId, createdWorktree: { path: created.path }, recordPath: path }
}

// Resolves a `session:start` target to a cwd/workspace/repoId, creating a session worktree only on
// an explicit `worktree: true` — the only place a start target becomes a cwd.
import { pathOps } from '@/main/platform/paths'
import type { Platform } from '@/main/platform'
import type { SessionStartMode, SessionStartTarget } from '@/types/hosting'
import { isReadyEntry } from '@/main/repos'
import { resolveWorkspace, toFolderId } from '@/main/repos/worktree/resolve'
import { createSessionWorktree } from '@/main/repos/worktree/worktree'
import type { StartTargetSources, ResolvedStartTarget } from '@/types/workspace'

function sessionIdOf(mode: SessionStartMode): string | null {
  return mode.kind === 'resume' || mode.kind === 'resume-at' || mode.kind === 'fork' ? mode.sessionId : null
}

async function resolveFolderPath(folderId: string, sources: StartTargetSources): Promise<string> {
  const readyPaths = sources.repositories.filter(isReadyEntry).map((entry) => entry.path)
  const recents = await sources.recents.load()
  const candidates = [...readyPaths, ...recents.map((entry) => entry.path)]
  const found = candidates.find((path) => toFolderId(pathOps.pathKey(path)) === folderId)
  if (found === undefined) throw new Error(`'session:start' found no folder registered with id '${folderId}'`)
  return found
}

async function resolveTranscriptCwd(ctx: Pick<Platform, 'fs'>, mode: SessionStartMode, sources: StartTargetSources): Promise<{ readonly ok: true; readonly cwd: string } | { readonly ok: false; readonly kind: 'folder-missing'; readonly path: string | null }> {
  const sessionId = sessionIdOf(mode)
  if (sessionId === null) throw new Error("'session:start' requires a transcript target's mode to carry a sessionId")

  const listed = await sources.readSessions()
  if (!listed.ok) throw new Error(`'session:start' could not list sessions for a transcript target: ${listed.message}`)

  const session = listed.sessions.find((candidate) => candidate.sessionId === sessionId)
  if (session === undefined || session.cwd === null) return { ok: false, kind: 'folder-missing', path: null }

  if (!(await ctx.fs.exists(session.cwd))) return { ok: false, kind: 'folder-missing', path: session.cwd }
  return { ok: true, cwd: session.cwd }
}

/** Resolves one `session:start` target into `{ cwd, workspace, repoId }`, creating a worktree when
 *  the target asks for one. An unknown `folderId` throws — a stale renderer, never a typed result. */
export async function resolveStartTarget(
  ctx: Pick<Platform, 'git' | 'fs'>,
  target: SessionStartTarget,
  mode: SessionStartMode,
  sources: StartTargetSources,
): Promise<ResolvedStartTarget> {
  if (target.kind === 'transcript') {
    const resolved = await resolveTranscriptCwd(ctx, mode, sources)
    if (!resolved.ok) return resolved
    const { workspace, repoId } = await resolveWorkspace(ctx, resolved.cwd, sources.repositories)
    return { ok: true, cwd: workspace.folder, workspace, repoId, createdWorktree: null, recordPath: null }
  }

  const path = await resolveFolderPath(target.folderId, sources)
  if (!(await ctx.fs.exists(path))) return { ok: false, kind: 'folder-missing', path }

  const resolved = await resolveWorkspace(ctx, path, sources.repositories)

  if (!target.worktree) {
    return { ok: true, cwd: resolved.workspace.folder, workspace: resolved.workspace, repoId: resolved.repoId, createdWorktree: null, recordPath: path }
  }

  if (resolved.workspace.root === null) return { ok: false, kind: 'not-git' }

  const created = await createSessionWorktree(ctx, { root: resolved.workspace.root })
  if (!created.ok) return { ok: false, kind: 'worktree-failed', message: created.message }

  const worktreeResolved = await resolveWorkspace(ctx, created.path, sources.repositories)
  return { ok: true, cwd: worktreeResolved.workspace.folder, workspace: worktreeResolved.workspace, repoId: worktreeResolved.repoId, createdWorktree: { path: created.path }, recordPath: path }
}

import type { HostedStore, SessionFilesResult, SessionKey, WorktreeChoice, RestorableSession, SessionStartMode, SessionStartTarget } from '@/types/hosting'
import type { ReposListResponse } from '@/types/ipc'
import type { RepoId, RepoProblem } from '@/utils/repos'
import type { SessionChanges } from '@/types/workspace'

import type { AppContext } from '@/main/app/context'
import { listSessionFiles } from '@/main/sessions/hosting/files'
import { isReadyEntry, type Repos } from '@/main/repos'
import { resolveStartTarget } from '@/main/repos/worktree/target'
import type { Platform } from '@/main/platform'
import { computeSessionChanges } from '@/main/repos/worktree/changes'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import { resolveWorkspace } from '@/main/repos/worktree/resolve'

type WithRepos = { readonly repos: Pick<Repos, 'list'> }
type WithLive<K extends keyof AppContext['live']> = { readonly live: Pick<AppContext['live'], K> }
type WithStores<K extends keyof AppContext['stores']> = { readonly stores: Pick<AppContext['stores'], K> }

export async function startSession(
  ctx: Pick<Platform, 'git' | 'fs' | 'clock'> & WithRepos & WithStores<'recents'> & WithLive<'hostedStore' | 'engine'>,
  input: { readonly target: SessionStartTarget; readonly mode: SessionStartMode },
): ReturnType<HostedStore['start']> {
  const list = await ctx.repos.list()
  const repositories = list.ok ? list.repositories : []
  const resolved = await resolveStartTarget(ctx, input.target, input.mode, { repositories, recents: ctx.stores.recents, readSessions: () => ctx.live.engine.listSessions() })
  if (!resolved.ok) return resolved

  const result = await ctx.live.hostedStore.start({ repoId: resolved.repoId, mode: input.mode, workspace: resolved.workspace })

  if (!result.ok && resolved.createdWorktree !== null) {
    const { path } = resolved.createdWorktree
    const outcome = await removeSessionWorktreeAt(ctx, { path, force: false })
    if (outcome.outcome === 'failed') console.error(`[hosting] could not clean up worktree '${path}' after a failed start: ${outcome.message}`)
  }
  if (result.ok && resolved.recordPath !== null) {
    await ctx.stores.recents.record(resolved.recordPath, ctx.clock.now())
  }
  return result
}

/** The `@` suggestion list's own file source — `sessionKey` resolves only to its own handle's `cwd`, so the renderer never names a path directly. */
export async function readSessionFiles(ctx: Pick<Platform, 'git' | 'fs'> & WithLive<'hostedStore'>, input: { readonly sessionKey: SessionKey }): Promise<SessionFilesResult> {
  const cwd = ctx.live.hostedStore.cwdOf(input.sessionKey)
  if (cwd === null) return { ok: false, kind: 'unknown-session' }
  const result = await listSessionFiles(ctx, cwd)
  if (!result.ok) return { ok: false, kind: 'unreadable', message: result.message }
  return { ok: true, files: result.files, truncated: result.truncated }
}

export function dismissSession(ctx: WithLive<'hostedStore'>, input: { readonly sessionKey: SessionKey; readonly worktree: WorktreeChoice }): ReturnType<HostedStore['dismiss']> {
  const { hostedStore } = ctx.live
  const snapshot = hostedStore.snapshotOf(input.sessionKey)
  if (snapshot !== null && snapshot.workspace.worktree === null && input.worktree !== 'keep') {
    throw new Error("'session:dismiss' requires 'worktree' to be 'keep' for a non-worktree session")
  }
  return hostedStore.dismiss(input.sessionKey, input.worktree)
}

export async function readSessionChanges(ctx: Pick<Platform, 'git' | 'clock'> & WithLive<'hostedStore'>, input: { readonly sessionKey: SessionKey }): Promise<SessionChanges> {
  const workspace = ctx.live.hostedStore.snapshotOf(input.sessionKey)?.workspace ?? null
  if (workspace === null) return { ok: false, kind: 'unknown-session', message: `no session is open for key '${input.sessionKey}'` }
  return computeSessionChanges(ctx, workspace)
}

/** A short, main-process-only reason string, distinct from the renderer's own `problemCopy`. */
function problemReason(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return 'its folder is gone'
    case 'not-a-git-repository':
      return "it isn't a git repository anymore"
    case 'not-port-managed':
      return "it's no longer port-managed"
    case 'config-malformed':
      return '.claude/port.config.json is not valid JSON'
    case 'config-invalid':
      return '.claude/port.config.json has no usable repo'
    case 'config-unreadable':
    case 'config-ref-unreadable':
      return "its config can't be read"
    case 'effective-config-unreadable':
      return `${problem.file} can't be read`
  }
}

function availabilityFor(repoId: RepoId, list: ReposListResponse): RestorableSession['availability'] {
  if (!list.ok) return { ok: false, reason: list.message }
  const found = list.repositories.find((repository) => repository.id === repoId)
  if (found === undefined) return { ok: false, reason: 'This repository is no longer registered.' }
  if (!isReadyEntry(found)) return { ok: false, reason: problemReason(found.problem) }
  return { ok: true }
}

/** A listing failure marks every registry-backed entry unavailable with its message, never an empty
 *  list. An entry carrying `cwd` restores by folder instead — its availability is just `exists(cwd)`. */
export async function restoreList(ctx: Pick<Platform, 'fs'> & WithRepos & WithLive<'hostedStore'>): Promise<{ readonly entries: readonly RestorableSession[] }> {
  const [entries, list] = await Promise.all([ctx.live.hostedStore.restorable(), ctx.repos.list()])
  const availability = await Promise.all(
    entries.map(async (entry) =>
      entry.cwd !== undefined
        ? (await ctx.fs.exists(entry.cwd)) ? ({ ok: true } as const) : ({ ok: false, reason: "This session's folder is gone." } as const)
        : availabilityFor(entry.repoId as RepoId, list),
    ),
  )
  return {
    entries: entries.map((entry, index) => ({
      restoreId: entry.restoreId,
      repoId: entry.repoId,
      folder: entry.cwd ?? null,
      title: entry.title,
      origin: { kind: 'resumed' as const, from: entry.claudeSessionId },
      startedAt: entry.startedAt,
      availability: availability[index] as RestorableSession['availability'],
    })),
  }
}

/** Returns `repo-unavailable`/`folder-missing` as values rather than throwing — an operator can hit either in normal use. */
export async function restoreSession(ctx: Pick<Platform, 'git' | 'fs'> & WithRepos & WithLive<'hostedStore'>, input: { readonly restoreId: string }): ReturnType<HostedStore['restore']> {
  const { hostedStore } = ctx.live
  const entries = await hostedStore.restorable()
  const entry = entries.find((candidate) => candidate.restoreId === input.restoreId)
  if (entry === undefined) return { ok: false, kind: 'unknown-restore' }

  const list = await ctx.repos.list()
  const repositories = list.ok ? list.repositories : []

  if (entry.cwd !== undefined) {
    if (!(await ctx.fs.exists(entry.cwd))) return { ok: false, kind: 'folder-missing', path: entry.cwd }
    const { workspace, repoId } = await resolveWorkspace(ctx, entry.cwd, repositories)
    return hostedStore.restore(input.restoreId, { repoId, workspace })
  }

  if (!list.ok) return { ok: false, kind: 'repo-unavailable', reason: list.message }
  const repository = list.repositories.find((candidate) => candidate.id === entry.repoId)
  if (repository === undefined) return { ok: false, kind: 'repo-unavailable', reason: 'This repository is no longer registered.' }
  if (!isReadyEntry(repository)) return { ok: false, kind: 'repo-unavailable', reason: problemReason(repository.problem) }

  const { workspace, repoId } = await resolveWorkspace(ctx, repository.path, repositories)
  return hostedStore.restore(input.restoreId, { repoId, workspace })
}

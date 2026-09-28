// #98: the fork UX decision, stated — a fork is a *separate,
// self-describing session*, not a variant of its parent. Once `init`
// reports the new id, read the parent's display title through #78's
// existing `createSdkSessionReader` (never a second reader spawning the SDK
// a second time) and rename the fork to a title distinct from its parent's
// — a fork sharing its parent's `firstPrompt`/summary would show two
// identical rows in #78's resumable list, exactly the "lose work in the
// wrong one" failure the ticket names. A rename failure is logged and
// reported as `titled: false`, never retried and never fatal — the fork
// still works.
import { createSdkSessionReader } from '../sessions/sdk'
import type { SessionReader } from '../sessions/sdk'

/** Bounded to 80 characters so a very long parent title never produces an
 *  unreadable row; skipped entirely (by the caller, `titleFork`) when the
 *  fork already carries its own custom title. */
const MAX_TITLE_LENGTH = 80
const FORK_SUFFIX = ' (fork)'

export function forkTitle(parentTitle: string): string {
  const trimmed = parentTitle.trim()
  const budget = MAX_TITLE_LENGTH - FORK_SUFFIX.length
  const base = trimmed.length > budget ? trimmed.slice(0, budget) : trimmed
  return `${base}${FORK_SUFFIX}`
}

export interface TitleForkParams {
  readonly parentSessionId: string
  readonly forkedSessionId: string
  /** The ready registry entry's own path — `renameSession`'s own `dir`
   *  option, so the search is scoped to this project rather than every
   *  project on disk. */
  readonly cwd: string
}

export interface TitleForkDeps {
  readonly listSessions: SessionReader
  readonly renameSession: (sessionId: string, title: string, options?: { readonly dir?: string }) => Promise<void>
}

/** Resolves the parent's display title (`customTitle ?? summary ??
 *  firstPrompt`), skips when the fork already has its own custom title, and
 *  renames otherwise. Returns `true` when the fork is titled (already was,
 *  or the rename succeeded) and `false` only when nothing could be
 *  resolved or the rename itself failed — logged here, surfaced as
 *  `HostedSessionSnapshot.titled`, never thrown. */
export async function titleFork(params: TitleForkParams, deps: TitleForkDeps): Promise<boolean> {
  try {
    const result = await deps.listSessions()
    if (!result.ok) return false

    const forked = result.sessions.find((session) => session.sessionId === params.forkedSessionId)
    if (forked?.customTitle) return true

    const parent = result.sessions.find((session) => session.sessionId === params.parentSessionId)
    const parentTitle = parent?.customTitle ?? parent?.summary ?? parent?.firstPrompt ?? null
    if (parentTitle === null) return false

    await deps.renameSession(params.forkedSessionId, forkTitle(parentTitle), { dir: params.cwd })
    return true
  } catch (error) {
    console.error(`[hosting] fork titling failed for '${params.forkedSessionId}':`, error)
    return false
  }
}

export const defaultForkListSessions: SessionReader = createSdkSessionReader()

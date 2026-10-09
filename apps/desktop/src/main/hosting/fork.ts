// A fork is renamed away from its parent's title so the two never show as identical rows in the resumable list.
import { createSdkSessionReader } from '../sessions/sdk'
import type { SessionReader } from '../sessions/sdk'

/** Bounded to 80 characters so a very long parent title never produces an unreadable row. */
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
  /** Scopes `renameSession`'s search to this project, not every project on disk. */
  readonly cwd: string
}

export interface TitleForkDeps {
  readonly listSessions: SessionReader
  readonly renameSession: (sessionId: string, title: string, options?: { readonly dir?: string }) => Promise<void>
}

/** Returns `false`, never throws, when nothing resolves a title or the rename itself fails. */
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

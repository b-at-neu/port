// A fork is renamed away from its parent's title so the two never show as identical rows in the resumable list.
import type { SdkModule } from '@/main/platform/sdk'
import type { ListSessionsResult, SessionReader } from '@/types/sessions'

/** Bounded to 80 characters so a very long parent title never produces an unreadable row. */
const MAX_TITLE_LENGTH = 80
const FORK_SUFFIX = ' (fork)'

export function forkTitle(parentTitle: string): string {
  const trimmed = parentTitle.trim()
  const budget = MAX_TITLE_LENGTH - FORK_SUFFIX.length
  const base = trimmed.length > budget ? trimmed.slice(0, budget) : trimmed
  return `${base}${FORK_SUFFIX}`
}

interface TitleForkParams {
  readonly parentSessionId: string
  readonly forkedSessionId: string
  /** Scopes `renameSession`'s search to this project, not every project on disk. */
  readonly cwd: string
}

type ForkRename = { readonly kind: 'titled' } | { readonly kind: 'rename'; readonly title: string } | { readonly kind: 'none' }

/** Decides what titling a fork needs from the session list alone. */
export function forkRename(list: ListSessionsResult, params: Pick<TitleForkParams, 'parentSessionId' | 'forkedSessionId'>): ForkRename {
  if (!list.ok) return { kind: 'none' }

  const forked = list.sessions.find((session) => session.sessionId === params.forkedSessionId)
  if (forked?.customTitle) return { kind: 'titled' }

  const parent = list.sessions.find((session) => session.sessionId === params.parentSessionId)
  const parentTitle = parent?.customTitle ?? parent?.summary ?? parent?.firstPrompt ?? null
  if (parentTitle === null) return { kind: 'none' }
  return { kind: 'rename', title: forkTitle(parentTitle) }
}

/** Returns `false`, never throws, when nothing resolves a title or the rename itself fails. */
export async function titleFork(sdk: Pick<SdkModule, 'renameSession'>, listSessions: SessionReader, params: TitleForkParams): Promise<boolean> {
  try {
    const decision = forkRename(await listSessions(), params)
    if (decision.kind === 'titled') return true
    if (decision.kind === 'none') return false

    await sdk.renameSession(params.forkedSessionId, decision.title, { dir: params.cwd })
    return true
  } catch (error) {
    console.error(`[hosting] fork titling failed for '${params.forkedSessionId}':`, error)
    return false
  }
}

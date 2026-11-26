import type { LocalRepoRef } from '@/types/github'
import type { SessionScan } from '@/types/sessions'
import type { StateEngine } from '@/main/pipeline/context'
import { isReadyEntry, type Repos } from '@/main/repos'

export async function scanSessions(ctx: { readonly repos: Pick<Repos, 'list'>; readonly live: { readonly engine: Pick<StateEngine, 'scanSessions'> } }): Promise<SessionScan> {
  const list = await ctx.repos.list()
  if (!list.ok) throw new Error(`'sessions:scan' could not list repositories: ${list.message}`)
  const repos: readonly LocalRepoRef[] = list.repositories.filter(isReadyEntry).map((entry) => ({ id: entry.id, root: entry.path }))
  return ctx.live.engine.scanSessions({ repos })
}

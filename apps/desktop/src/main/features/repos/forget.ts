import type { AppContext } from '@/main/app/context'
import type { RepoId } from '@/utils/repos'

/** Forgetting a repo's run-state entry and cached ETags never fails the registry call itself, only logs. A re-added checkout gets the same id, so add forgets too. */
export function forgetRepoState(ctx: AppContext, action: string, repoId: RepoId): void {
  void ctx.live.engine.forgetRepo({ repoId })
  void ctx.stores.runStates.forget(repoId).then((forgotten) => {
    if (!forgotten.ok) console.error(`'${action}' could not forget the run-state entry for '${String(repoId)}':`, forgotten.message)
  })
}

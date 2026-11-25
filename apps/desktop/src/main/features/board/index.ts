import type { PipelineWatcher } from '@/types/state'
import type { RepoId } from '@/utils/repos'

/** A refresh failure is logged and swallowed so it never masks the write's own success. */
export async function refreshAfterWrite(ctx: { readonly live: { readonly watcher: Pick<PipelineWatcher, 'refresh'> } }, subject: string, repoId: RepoId): Promise<void> {
  try {
    await ctx.live.watcher.refresh({ repoId, source: 'github' })
  } catch (error) {
    console.error(`${subject} post-write refresh failed for '${repoId}':`, error)
  }
}

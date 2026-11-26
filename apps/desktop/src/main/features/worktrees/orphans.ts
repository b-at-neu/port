// Directories beside a registered worktree that git does not track at all — reported, never deleted by a read.
import type { AppContext } from '@/main/app/context'
import { pathOps } from '@/main/platform/paths'
import type { OrphanInput } from '@/types/reclaimer'
import { orphanVerdict } from '@/main/features/worktrees/classify'

export interface OrphanCandidate {
  readonly path: string
  readonly isOutside: boolean
}

const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m

/** The one fact `orphanVerdict` needs: what a directory's own `.git` entry is, and where a file one points. */
async function gitEntryOf(ctx: Pick<AppContext, 'fs'>, dir: string): Promise<OrphanInput> {
  const { fs } = ctx
  const gitPath = pathOps.join(dir, '.git')
  const stat = await fs.stat(gitPath)
  if (!stat.ok) return { gitEntry: stat.kind === 'not-found' ? 'none' : 'unreadable', gitdirTargetExists: false }
  if (stat.value.kind === 'directory') return { gitEntry: 'dir', gitdirTargetExists: false }

  const text = await fs.readText(gitPath)
  if (!text.ok) return { gitEntry: 'unreadable', gitdirTargetExists: false }
  const target = GITDIR_LINE.exec(text.value)?.[1]
  const targetExists = target !== undefined && (await fs.exists(pathOps.resolveFrom(dir, target)))
  return { gitEntry: 'file', gitdirTargetExists: targetExists }
}

/** Scans the parent of every non-outside candidate, plus `<main>/.claude/worktrees` when it exists; an unreadable parent is skipped. */
export async function findOrphanDirs(ctx: Pick<AppContext, 'fs'>, mainPath: string, candidates: readonly OrphanCandidate[]): Promise<readonly string[]> {
  const { fs } = ctx
  const registered = new Set<string>(candidates.map((c) => pathOps.pathKey(c.path)))
  registered.add(pathOps.pathKey(mainPath))

  const parents = new Map<string, string>()
  for (const c of candidates) {
    if (c.isOutside) continue
    const parent = pathOps.dirname(c.path)
    parents.set(pathOps.pathKey(parent), parent)
  }
  const worktreesDir = pathOps.join(mainPath, '.claude', 'worktrees')
  parents.set(pathOps.pathKey(worktreesDir), worktreesDir)

  const found = new Map<string, string>()
  for (const parent of parents.values()) {
    const listing = await fs.list(parent)
    if (!listing.ok) continue
    for (const entry of listing.value) {
      const full = pathOps.join(parent, entry.name)
      const key = pathOps.pathKey(full)
      if (registered.has(key) || found.has(key)) continue
      const stat = await fs.stat(full)
      if (!stat.ok || stat.value.kind !== 'directory') continue
      if (orphanVerdict(await gitEntryOf(ctx, full)) === 'orphan') found.set(key, full)
    }
  }
  return [...found.values()]
}

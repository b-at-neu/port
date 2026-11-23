import { pathExists, readTextFile } from '@/main/platform/files'
import { defaultGitRunner } from '@/main/platform/git'
import { pathOps } from '@/main/platform/paths'
import { stageBundleRoot } from '@/main/dispatch/stage/bundle'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import { defaultStageInstructionsLoader } from '@/main/dispatch/stage/instructions'
import { createStageWorktree, releaseStageBranch, sweepSessionBranches } from '@/main/repos/worktree/stage-worktree'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import type { StageBundleRootInput, StageLauncherHandle } from '@/types/stage'

type StageLauncherParams = Parameters<typeof createStageLauncher>[0]

type DefaultStageLauncherParams = Pick<StageLauncherParams, 'store' | 'registry' | 'onOutcome' | 'onResumedTurn' | 'onResumed' | 'onDenial'> & { readonly bundle: StageBundleRootInput }

/** The app's real launcher: every I/O seam bound to its production implementation. */
export function createDefaultStageLauncher({ bundle, ...params }: DefaultStageLauncherParams): StageLauncherHandle {
  const git = defaultGitRunner()
  const bundleRoot = stageBundleRoot(bundle)
  return createStageLauncher({
    ...params,
    git,
    createWorktree: createStageWorktree,
    removeWorktree: (path, force) => removeSessionWorktreeAt({ path, force, git }),
    releaseBranch: (root, branch, baseSha) => releaseStageBranch({ root, git, branch, baseSha }),
    sweepBranches: (root) => sweepSessionBranches({ root, git }),
    now: () => new Date(),
    newId: () => globalThis.crypto.randomUUID(),
    loadInstructions: defaultStageInstructionsLoader(bundleRoot),
    bundleRoot,
    readTextFile,
    pathExists,
    ops: pathOps,
  })
}

import { defaultGitRunner } from '@/main/platform/git'
import { createStageLauncher } from '@/main/stage/launcher'
import { defaultStageInstructionsLoader } from '@/main/stage/instructions'
import { createStageWorktree, releaseStageBranch, sweepSessionBranches } from '@/main/workspace/stage-worktree'
import { removeSessionWorktreeAt } from '@/main/workspace/worktree'
import type { StageLauncherHandle } from '@/types/stage'

type StageLauncherParams = Parameters<typeof createStageLauncher>[0]

type DefaultStageLauncherParams = Pick<StageLauncherParams, 'store' | 'registry' | 'onOutcome' | 'onDenial'>

/** The app's real launcher: every I/O seam bound to its production implementation. */
export function createDefaultStageLauncher(params: DefaultStageLauncherParams): StageLauncherHandle {
  const git = defaultGitRunner()
  return createStageLauncher({
    ...params,
    git,
    createWorktree: createStageWorktree,
    removeWorktree: (path, force) => removeSessionWorktreeAt({ path, force, git }),
    releaseBranch: (root, branch, baseSha) => releaseStageBranch({ root, git, branch, baseSha }),
    sweepBranches: (root) => sweepSessionBranches({ root, git }),
    now: () => new Date(),
    newId: () => globalThis.crypto.randomUUID(),
    loadInstructions: defaultStageInstructionsLoader(),
  })
}

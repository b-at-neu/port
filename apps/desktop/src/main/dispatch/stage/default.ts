import { hostFs } from '@/main/platform'
import { pathExists, readTextFile } from '@/main/platform/files'
import { defaultGitRunner } from '@/main/platform/git'
import { pathOps } from '@/main/platform/paths'
import { stageBundleRoot } from '@/main/dispatch/stage/bundle'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import { defaultStageInstructionsLoader } from '@/main/dispatch/stage/instructions'
import { readStagePrompt, stagePromptsDir } from '@/main/sessions/hosting/stage-prompt-store'
import { createStageWorktree, releaseStageBranch, sweepSessionBranches } from '@/main/repos/worktree/stage-worktree'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import type { StageBundleRootInput, StageLauncherHandle } from '@/types/stage'

type StageLauncherParams = Parameters<typeof createStageLauncher>[0]

type DefaultStageLauncherParams = Pick<StageLauncherParams, 'store' | 'runs' | 'onOutcome' | 'onResumedTurn'> & { readonly bundle: StageBundleRootInput; readonly userData: string }

/** The app's real launcher: every I/O seam bound to its production implementation. */
export function createDefaultStageLauncher({ bundle, userData, ...params }: DefaultStageLauncherParams): StageLauncherHandle {
  const git = defaultGitRunner()
  const ctx = { git, fs: hostFs }
  const bundleRoot = stageBundleRoot(bundle)
  return createStageLauncher({
    ...params,
    git,
    createWorktree: (p) => createStageWorktree(ctx, p),
    removeWorktree: (path, force) => removeSessionWorktreeAt(ctx, { path, force }),
    releaseBranch: (root, branch, baseSha) => releaseStageBranch(ctx, { root, branch, baseSha }),
    sweepBranches: (root) => sweepSessionBranches(ctx, root),
    now: () => new Date(),
    newId: () => globalThis.crypto.randomUUID(),
    loadInstructions: defaultStageInstructionsLoader(bundleRoot),
    readStagePrompt: (sessionId) => readStagePrompt(hostFs, stagePromptsDir(userData), sessionId),
    bundleRoot,
    readTextFile,
    pathExists,
    ops: pathOps,
  })
}

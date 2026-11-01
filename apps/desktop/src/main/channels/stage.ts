import type { ResolvedStageRoot, RecoverDeps } from '@/types/stage'

// `stage:allow`, `stage:dismiss-denial`, `stage:resume`, `stage:restart` — the renderer's own
// seam into `main/stage/`'s allow/resume/restart compositions. Nothing else may call these.
import type { IpcMap } from '@/types/ipc'
import type { StageAllowIo, StageAllowResult, StageDenial, StageResumeResult, StageRestartResult } from '@/types/stage'
import type { RegistryDeps } from '@/types/registry'
import { requireReadyRepo } from '@/main/registry'
import { readAllowBase } from '@/main/github/allow'
import { mergeRule } from '@/main/stage/allowlist'
import { validateRule } from '@/main/stage/rule'
import { allowBranchName, proposeAllowRule } from '@/main/writes/allow'
import { resumeStage, restartStage } from '@/main/stage/recover'
import { createInterruptedSweeper } from '@/main/stage/sweep'



import type { RepoId } from '@/utils/repos'
import type { StageChannelDeps } from '@/types/channels'

export const defaultAllowIo: StageAllowIo = { read: readAllowBase, propose: proposeAllowRule }

function findDenial(dispatcher: StageChannelDeps['dispatcher'], repoId: RepoId, denialId: string): StageDenial | null {
  const status = dispatcher.status().find((s) => s.repoId === repoId)
  return status?.denials.find((d) => d.id === denialId) ?? null
}

export async function resolveStageAllow(registryDeps: RegistryDeps, request: IpcMap['stage:allow']['request'], deps: StageChannelDeps): Promise<StageAllowResult> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') throw new Error("'stage:allow' requires a non-empty 'repoId'")
  if (typeof request.denialId !== 'string' || request.denialId === '') throw new Error("'stage:allow' requires a non-empty 'denialId'")
  if (typeof request.rule !== 'string' || request.rule.length === 0 || request.rule.length > 300) {
    throw new Error("'stage:allow' requires 'rule' to be a string of 1 to 300 characters")
  }

  const repoId = request.repoId
  const denial = findDenial(deps.dispatcher, repoId, request.denialId)
  if (denial === null) return { kind: 'unknown-denial' }

  const validated = validateRule(request.rule)
  if (!validated.ok) return { kind: 'invalid-rule', reason: validated.reason }

  const found = await requireReadyRepo(registryDeps, "'stage:allow'", repoId, deps.listRepositories)
  const integration = found.config.branches.integration
  const base = await deps.allow.read({ repo: { owner: found.config.owner, name: found.config.name }, integration, branch: allowBranchName(validated.rule) })
  if (!base.ok) return { kind: 'failed', step: 'read', message: base.message }
  if (base.openPr !== null) {
    deps.dispatcher.clearDenialsFor(repoId, denial.rule)
    return { kind: 'already-proposed', ...base.openPr }
  }

  const merged = mergeRule({ settingsText: base.settingsText, configText: base.configText, rule: validated.rule })
  if (merged.kind === 'invalid-rule') return { kind: 'invalid-rule', reason: merged.reason }
  if (merged.kind === 'unparseable') return { kind: 'failed', step: 'read', message: `${merged.file} isn't valid JSON on ${integration}` }
  if (merged.kind === 'already-allowed') {
    deps.dispatcher.clearDenialsFor(repoId, denial.rule)
    return { kind: 'already-allowed', integration }
  }

  const proposed = await deps.allow.propose(
    { repo: found.config.repo, repoId, auditDir: deps.auditDir, scratchDir: deps.scratchDir },
    { head: base.head, files: merged.files, rule: merged.rule, denial, integration },
  )
  if (!proposed.ok) return { kind: 'failed', step: proposed.step, message: proposed.message }
  deps.dispatcher.clearDenialsFor(repoId, denial.rule)
  return { kind: 'proposed', number: proposed.number, url: proposed.url }
}

export function resolveStageDismissDenial(request: IpcMap['stage:dismiss-denial']['request'], deps: Pick<StageChannelDeps, 'dispatcher'>): void {
  if (typeof request?.repoId !== 'string' || request.repoId === '') throw new Error("'stage:dismiss-denial' requires a non-empty 'repoId'")
  if (typeof request.denialId !== 'string' || request.denialId === '') throw new Error("'stage:dismiss-denial' requires a non-empty 'denialId'")
  deps.dispatcher.dismissDenial(request.repoId, request.denialId)
}

async function readyRootsOf(registryDeps: RegistryDeps, deps: Pick<StageChannelDeps, 'listRepositories'>): Promise<ReadonlyMap<RepoId, ResolvedStageRoot>> {
  const list = await deps.listRepositories(registryDeps)
  const map = new Map<RepoId, ResolvedStageRoot>()
  if (!list.ok) return map
  for (const entry of list.repositories) {
    if ('config' in entry) map.set(entry.id, { path: entry.path, sessionRequiredPaths: entry.config.sessionRequiredPaths })
  }
  return map
}

function recoverDepsOf(registryDeps: RegistryDeps, roots: ReadonlyMap<RepoId, ResolvedStageRoot>, deps: StageChannelDeps): RecoverDeps {
  return {
    registry: deps.registry,
    store: deps.store,
    resume: deps.launcher.resume,
    removeWorktree: deps.removeWorktree,
    releaseBranch: deps.releaseBranch,
    resolveEntry: (repoId) => roots.get(repoId) ?? null,
    applyRetry: async (interrupted) => {
      const found = await requireReadyRepo(registryDeps, "'stage:restart'", interrupted.repoId, deps.listRepositories)
      return deps.applyItemAction({
        request: { repoId: interrupted.repoId, kind: interrupted.kind, number: interrupted.number, action: 'retry', expectedStage: interrupted.inFlight },
        snapshot: deps.snapshot(),
        entry: found,
        auditDir: deps.auditDir,
      })
    },
    capacity: async () => {
      const c = await deps.store.capacity()
      return { limit: c.limit }
    },
  }
}

export async function resolveStageResume(registryDeps: RegistryDeps, request: IpcMap['stage:resume']['request'], deps: StageChannelDeps): Promise<StageResumeResult> {
  if (typeof request?.id !== 'string' || request.id === '') throw new Error("'stage:resume' requires a non-empty 'id'")
  const roots = await readyRootsOf(registryDeps, deps)
  return resumeStage(recoverDepsOf(registryDeps, roots, deps), request.id)
}

/** The sweeper resumes through `resolveStageResume`, so the capacity and root checks exist once. */
export function createStageSweeper(registryDeps: RegistryDeps, deps: StageChannelDeps, hooks: Pick<Parameters<typeof createInterruptedSweeper>[0], 'fetchItemsByNumber' | 'onChange'>): ReturnType<typeof createInterruptedSweeper> {
  return createInterruptedSweeper({
    registry: deps.registry,
    removeWorktree: deps.removeWorktree,
    resume: (id) => resolveStageResume(registryDeps, { id }, deps),
    now: () => new Date(),
    ...hooks,
  })
}

export async function resolveStageRestart(registryDeps: RegistryDeps, request: IpcMap['stage:restart']['request'], deps: StageChannelDeps): Promise<StageRestartResult> {
  if (typeof request?.id !== 'string' || request.id === '') throw new Error("'stage:restart' requires a non-empty 'id'")
  const roots = await readyRootsOf(registryDeps, deps)
  return restartStage(recoverDepsOf(registryDeps, roots, deps), request.id)
}

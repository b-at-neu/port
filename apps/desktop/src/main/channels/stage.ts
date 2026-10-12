import type { ResolvedStageRoot, RecoverDeps } from '@/types/stage'

// `stage:allow`, `stage:dismiss-denial`, `stage:resume`, `stage:restart` — the renderer's own
// seam into `main/stage/`'s allow/resume/restart compositions. Nothing else may call these.
import type { IpcMap } from '@/types/ipc'
import type { StageAllowResult, StageDenial, StageResumeResult, StageRestartResult } from '@/types/stage'
import type { RegistryDeps } from '@/types/registry'
import { requireReadyRepo } from '@/main/registry'
import { allowRule } from '@/main/stage/allowlist'
import { resumeStage, restartStage } from '@/main/stage/recover'



import type { RepoId } from '@/utils/repos'
import type { StageChannelDeps } from '@/types/channels'

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

  const found = await requireReadyRepo(registryDeps, "'stage:allow'", repoId, deps.listRepositories)
  const result = await allowRule({ root: found.path, rule: request.rule, readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic })
  if (result.kind === 'ok' || result.kind === 'already-allowed') deps.dispatcher.clearDenialsFor(repoId, denial.rule)
  return result
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
    removeWorktree: deps.removeWorktree,
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

export async function resolveStageRestart(registryDeps: RegistryDeps, request: IpcMap['stage:restart']['request'], deps: StageChannelDeps): Promise<StageRestartResult> {
  if (typeof request?.id !== 'string' || request.id === '') throw new Error("'stage:restart' requires a non-empty 'id'")
  const roots = await readyRootsOf(registryDeps, deps)
  return restartStage(recoverDepsOf(registryDeps, roots, deps), request.id)
}

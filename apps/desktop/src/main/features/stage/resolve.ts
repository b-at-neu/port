// `stage:allow` and `stage:dismiss-denial` — the renderer's own seam into `main/dispatch/stage/`'s allow composition.
import type { StageAllowResult, StageDenial } from '@/types/stage'
import type { RegistryDeps } from '@/types/registry'
import { requireReadyRepo } from '@/main/repos'
import { mergeRule } from '@/main/dispatch/stage/allowlist'
import { validateRule } from '@/main/dispatch/stage/rule'
import { allowBranchName } from '@/main/github/writes/allow'
import type { RepoId } from '@/utils/repos'
import type { StageChannelDeps } from '@/main/app/seams'

function findDenial(dispatcher: StageChannelDeps['dispatcher'], repoId: RepoId, denialId: string): StageDenial | null {
  const status = dispatcher.status().find((s) => s.repoId === repoId)
  return status?.denials.find((d) => d.id === denialId) ?? null
}

export async function resolveStageAllow(registryDeps: RegistryDeps, request: { readonly repoId: RepoId; readonly denialId: string; readonly rule: string }, deps: StageChannelDeps): Promise<StageAllowResult> {
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

export function resolveStageDismissDenial(request: { readonly repoId: RepoId; readonly denialId: string }, deps: Pick<StageChannelDeps, 'dispatcher'>): void {
  if (typeof request?.repoId !== 'string' || request.repoId === '') throw new Error("'stage:dismiss-denial' requires a non-empty 'repoId'")
  if (typeof request.denialId !== 'string' || request.denialId === '') throw new Error("'stage:dismiss-denial' requires a non-empty 'denialId'")
  deps.dispatcher.dismissDenial(request.repoId, request.denialId)
}


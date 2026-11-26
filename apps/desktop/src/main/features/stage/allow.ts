// `stage.allow` — "Allow from now on": proposes one allow rule as a pull request and clears the denial it answers.
import type { StageAllowResult, StageDenial } from '@/types/stage'
import type { AppContext } from '@/main/app/context'
import { readyEntryOf } from '@/main/pipeline/context'
import { readAllowBase } from '@/main/github/allow'
import { allowBranchName, proposeAllowRule } from '@/main/github/writes/allow'
import { mergeRule } from '@/main/dispatch/stage/allowlist'
import { validateRule } from '@/main/dispatch/stage/rule'
import type { RepoId } from '@/utils/repos'

type AllowContext = Pick<AppContext, 'repos' | 'live' | 'paths' | 'githubHttp' | 'ghWrite' | 'git' | 'clock'>

function findDenial(ctx: Pick<AppContext, 'live'>, repoId: RepoId, denialId: string): StageDenial | null {
  const status = ctx.live.dispatcher.status().find((s) => s.repoId === repoId)
  return status?.denials.find((d) => d.id === denialId) ?? null
}

export async function allowDenial(ctx: AllowContext, input: { readonly repoId: RepoId; readonly denialId: string; readonly rule: string }): Promise<StageAllowResult> {
  const { repoId } = input
  const denial = findDenial(ctx, repoId, input.denialId)
  if (denial === null) return { kind: 'unknown-denial' }

  const validated = validateRule(input.rule)
  if (!validated.ok) return { kind: 'invalid-rule', reason: validated.reason }

  const entry = await readyEntryOf(ctx, "'stage:allow'", repoId, (message) => `'stage:allow' could not list repositories: ${message}`)
  const integration = entry.config.branches.integration
  const base = await readAllowBase(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, integration, branch: allowBranchName(validated.rule) })
  if (!base.ok) return { kind: 'failed', step: 'read', message: base.message }
  if (base.openPr !== null) {
    ctx.live.dispatcher.clearDenialsFor(repoId, denial.rule)
    return { kind: 'already-proposed', ...base.openPr }
  }

  const merged = mergeRule({ settingsText: base.settingsText, configText: base.configText, rule: validated.rule })
  if (merged.kind === 'invalid-rule') return { kind: 'invalid-rule', reason: merged.reason }
  if (merged.kind === 'unparseable') return { kind: 'failed', step: 'read', message: `${merged.file} isn't valid JSON on ${integration}` }
  if (merged.kind === 'already-allowed') {
    ctx.live.dispatcher.clearDenialsFor(repoId, denial.rule)
    return { kind: 'already-allowed', integration }
  }

  const proposed = await proposeAllowRule(
    ctx,
    { repo: entry.config.repo, repoId, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp },
    { head: base.head, files: merged.files, rule: merged.rule, denial, integration },
  )
  if (!proposed.ok) return { kind: 'failed', step: proposed.step, message: proposed.message }
  ctx.live.dispatcher.clearDenialsFor(repoId, denial.rule)
  return { kind: 'proposed', number: proposed.number, url: proposed.url }
}

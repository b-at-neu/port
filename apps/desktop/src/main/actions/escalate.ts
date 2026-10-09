// #293: escalateToHuman — swap the trigger label for `needsHuman`, then
// comment why, the same ordering `main/actions/gate.ts`'s own
// `gateAnswer` follows for `request-changes` (swap first here, since the
// cockpit's own escalation shape is swap-then-comment rather than
// comment-then-swap: a failed comment still leaves the item stopped, and a
// failed swap never posts a comment that would repeat on every poll).
// Generic on purpose — the budget gate (#293) and #292's cycle-cap and
// zero-diff escalations all call this same function, never a second
// `applyLabels` + `postComment` pair.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import { applyLabels, postComment } from '../writes/apply'
import type { ApplyLabelsParams, PostCommentParams } from '../writes/apply'
import type { ReadyEntry } from './apply'

export interface EscalateToHumanParams {
  readonly entry: ReadyEntry
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  /** The in-flight label's own trigger — removed, with `needsHuman` added.
   *  `applyLabels` gates every write on ownership uniformly now, so a
   *  `planApproved`/`planChangesRequested` trigger needs no scope of its
   *  own beyond that. */
  readonly trigger: LabelKey
  readonly viewer: string
  readonly body: string
  readonly action: string
  readonly auditDir: string
  readonly scratchDir: string
}

export interface EscalateToHumanDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
}

export const defaultEscalateDeps: EscalateToHumanDeps = { applyLabels, postComment }

export interface EscalateToHumanResult {
  readonly labels: WriteOutcome
  /** `null` when the label swap itself did not reach `applied` — a comment
   *  is never attempted on an item this call did not actually stop. */
  readonly comment: WriteOutcome | null
}

function buildWriteRequest(params: EscalateToHumanParams): LabelWriteRequest {
  return {
    repoId: params.entry.id,
    repo: params.entry.config.repo,
    kind: params.kind,
    number: params.number,
    vocabulary: params.entry.config.vocabulary,
    add: ['needsHuman'],
    remove: [params.trigger],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: [params.trigger], absent: ['needsHuman'], assignees: { kind: 'exactly', logins: [params.viewer] } },
    action: params.action,
  }
}

export async function escalateToHuman(params: EscalateToHumanParams, deps: EscalateToHumanDeps = defaultEscalateDeps): Promise<EscalateToHumanResult> {
  const labels = await deps.applyLabels({ request: buildWriteRequest(params), repoRoot: params.entry.path, auditDir: params.auditDir })
  if (labels.kind !== 'applied') return { labels, comment: null }

  const comment = await deps.postComment({
    request: { repoId: params.entry.id, repo: params.entry.config.repo, kind: params.kind, number: params.number, body: params.body, action: params.action, scratchDir: params.scratchDir },
    repoRoot: params.entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}

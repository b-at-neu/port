// Swaps the trigger label for `needsHuman`, then comments — a failed swap never posts a
// comment that would repeat on every poll.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import { applyLabels, postComment } from '../writes/apply'
import type { ApplyLabelsParams, PostCommentParams } from '../writes/apply'
import type { ReadyEntry } from './apply'

export interface EscalateToHumanParams {
  readonly entry: ReadyEntry
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
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
  /** `null` when the label swap did not reach `applied` — no comment is attempted then. */
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

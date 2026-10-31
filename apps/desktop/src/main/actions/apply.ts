import type { ApplyLabelsParams } from '@/types/writes'
import type { RecoverPausedTriggerParams, RecoverPausedTriggerResult } from '@/types/actions'

// A renderer-supplied `expectedStage` is only ever grounds to refuse, never to widen a plan.
import { actionsFor, stageKeyOf } from '@/utils/actions/plan'
import type { ActionPlan, ItemActionResult } from '@/types/actions'
import { labelName } from '@/utils/labels/vocabulary'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { applyLabels } from '@/main/writes/apply'

import { recoverPausedTrigger } from '@/main/actions/resume'

import type { ApplyItemActionParams, ItemActionRequest, ReadyEntry } from '@/types/actions'


export interface ApplyItemActionDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly recoverPausedTrigger: (params: RecoverPausedTriggerParams) => Promise<RecoverPausedTriggerResult>
}

export const defaultApplyItemActionDeps: ApplyItemActionDeps = { applyLabels, recoverPausedTrigger }

export function findRepoState(snapshot: BoardSnapshot, repoId: RepoId): Extract<RepositoryState, { readonly ok: true }> | null {
  const state = snapshot.state.repositories.find((repository) => repository.repoId === repoId)
  return state !== undefined && state.ok ? state : null
}

function findItem(repoState: Extract<RepositoryState, { readonly ok: true }>, kind: ItemActionRequest['kind'], number: number): ReconciledItem | null {
  return repoState.items.find((item) => item.kind === kind && item.number === number) ?? null
}

/** Display form for a stage key, used only for the `moved` refusal's copy. */
function stageDisplayName(vocabulary: ReadyEntry['config']['vocabulary'], key: LabelKey | null): string {
  if (key === null) return 'no stage'
  return labelName(vocabulary, key) ?? key
}

export function movedResult(
  vocabulary: ReadyEntry['config']['vocabulary'],
  expected: LabelKey | null,
  observed: LabelKey | null | 'gone',
): { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string } {
  return {
    ok: false,
    reason: 'moved',
    expected: stageDisplayName(vocabulary, expected),
    observed: observed === 'gone' ? 'no longer tracked' : stageDisplayName(vocabulary, observed),
  }
}

function buildWriteRequest(entry: ReadyEntry, request: ItemActionRequest, plan: ActionPlan): LabelWriteRequest {
  return {
    repoId: entry.id,
    repo: entry.config.repo,
    kind: request.kind,
    number: request.number,
    vocabulary: entry.config.vocabulary,
    add: plan.add,
    remove: plan.remove,
    addAssignees: plan.addAssignees,
    removeAssignees: plan.removeAssignees,
    expect: plan.expect,
    action: plan.action,
  }
}

export async function applyItemAction(params: ApplyItemActionParams, deps: ApplyItemActionDeps = defaultApplyItemActionDeps): Promise<ItemActionResult> {
  const { request, snapshot, entry, auditDir } = params
  const repoState = findRepoState(snapshot, entry.id)
  if (repoState === null) return { ok: false, reason: 'repo-unavailable' }

  const item = findItem(repoState, request.kind, request.number)
  if (item === null) return movedResult(entry.config.vocabulary, request.expectedStage, 'gone')

  const currentStage = stageKeyOf(item)
  if (currentStage !== request.expectedStage) return movedResult(entry.config.vocabulary, request.expectedStage, currentStage)

  const availability = actionsFor({ item, viewer: repoState.viewer, approvalGate: repoState.approvalGate })[request.action]
  if (!availability.available) {
    if (availability.reason === 'viewer-unknown') return { ok: false, reason: 'viewer-unknown' }
    if (availability.reason === 'not-owned') return { ok: false, reason: 'not-owned', owners: item.assignees }
    // 'not-applicable' here means a client bug, not a real race — stage drift was ruled out above.
    throw new Error(`'${request.action}' is not applicable to ${request.kind} #${String(request.number)}`)
  }

  let plan = availability.plan
  if (request.action === 'resume') {
    const recovered = await deps.recoverPausedTrigger({ auditDir, repo: entry.config.repo, number: request.number, vocabulary: entry.config.vocabulary })
    if (recovered.kind === 'no-record') return { ok: false, reason: 'no-pause-record' }
    if (recovered.kind === 'unresolvable') return { ok: false, reason: 'pause-record-unresolvable' }
    plan = { ...plan, add: [recovered.trigger] }
  }

  const outcome = await deps.applyLabels({ request: buildWriteRequest(entry, request, plan), repoRoot: entry.path, auditDir })
  return { ok: true, outcome }
}

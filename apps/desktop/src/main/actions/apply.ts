// applyItemAction — the single-label operator actions' only `applyLabels`
// caller (#94, wiring #90's write chokepoint into the app for the first
// time). Rebuilds the plan from the watcher's own snapshot and the
// registry's vocabulary; a renderer-supplied `expectedStage` is only ever
// grounds to refuse, never to widen a plan.
import { actionsFor, stageKeyOf } from '../../shared/actions/plan'
import type { ActionPlan, ItemActionResult, OperatorAction } from '../../shared/actions/types'
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import { applyLabels } from '../writes'
import type { ApplyLabelsParams } from '../writes'
import { recoverPausedTrigger } from './resume'
import type { RecoverPausedTriggerParams, RecoverPausedTriggerResult } from './resume'

export type ReadyEntry = Extract<RepositoryEntry, { readonly status: 'ready' }>

export interface ItemActionRequest {
  readonly repoId: RepoId
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly action: OperatorAction
  /** The `StageLabel.key` the renderer's own row carried when the operator
   *  clicked, `null` when the row showed no stage at all (resume). Compared
   *  against a fresh read of the same item — a mismatch means the board
   *  moved on since the click, and the action is refused, never widened. */
  readonly expectedStage: LabelKey | null
}

export interface ApplyItemActionParams {
  readonly request: ItemActionRequest
  readonly snapshot: BoardSnapshot
  readonly entry: ReadyEntry
  readonly auditDir: string
}

export interface ApplyItemActionDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly recoverPausedTrigger: (params: RecoverPausedTriggerParams) => Promise<RecoverPausedTriggerResult>
}

export const defaultApplyItemActionDeps: ApplyItemActionDeps = { applyLabels, recoverPausedTrigger }

function findRepoState(snapshot: BoardSnapshot, repoId: RepoId): Extract<RepositoryState, { readonly ok: true }> | null {
  const state = snapshot.state.repositories.find((repository) => repository.repoId === repoId)
  return state !== undefined && state.ok ? state : null
}

function findItem(repoState: Extract<RepositoryState, { readonly ok: true }>, kind: ItemActionRequest['kind'], number: number): ReconciledItem | null {
  return repoState.items.find((item) => item.kind === kind && item.number === number) ?? null
}

/** Display form for a stage key — `'no stage'` for `null`, the resolved
 *  label name (or the bare key, if the vocabulary somehow no longer
 *  resolves it) otherwise. Used only for the `moved` refusal's copy. */
function stageDisplayName(vocabulary: ReadyEntry['config']['vocabulary'], key: LabelKey | null): string {
  if (key === null) return 'no stage'
  return labelName(vocabulary, key) ?? key
}

function movedResult(vocabulary: ReadyEntry['config']['vocabulary'], expected: LabelKey | null, observed: LabelKey | null | 'gone'): ItemActionResult {
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

/**
 * Fixed order: find the `ReconciledItem` in the watcher's own snapshot
 * (never a renderer-supplied label set) → refuse `moved` when
 * `request.expectedStage` disagrees with what the snapshot now holds,
 * naming both → `actionsFor` → refuse on `not-owned`/`viewer-unknown` →
 * resume only: recover the paused trigger from the audit log → build the
 * `LabelWriteRequest` from the plan plus the registry entry's own
 * vocabulary/repo → `applyLabels`.
 */
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
    // 'not-applicable' here means the renderer requested an action its own
    // projection never marked available and the stage-drift check above
    // already agreed with the fresh read — a client bug, not a real race.
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

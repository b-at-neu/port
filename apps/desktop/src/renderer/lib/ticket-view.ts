import type { PipelineItemKind } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import { stageKeyOf } from '@/utils/actions/plan'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { stageNameOf } from '@/utils/pipeline/stages'
import type { StageStatus, TicketView } from '@/utils/pipeline/stages'
import { V1_KEY_MEANING } from '@/utils/pipeline/ticket'
import type { Gate, QueueReason, Stage, StatusKind } from '@/utils/pipeline/ticket'

function kindStage(kind: PipelineItemKind): Stage {
  return kind === 'issue' ? 'implement' : 'review'
}

function stateStatus(status: StatusKind, reason: QueueReason | undefined, gate: Gate | undefined): StageStatus {
  if (status === 'queued') return { kind: 'queued', reason: reason ?? 'new' }
  if (status === 'waiting-on-you') return { kind: 'waiting-on-you', gate: gate ?? 'escalation' }
  return { kind: status }
}

export function viewOfKey(key: LabelKey, kind: PipelineItemKind): TicketView | null {
  const meaning = V1_KEY_MEANING[key]
  if (key === 'blocked') return { stage: kindStage(kind), status: { kind: 'blocked' } }
  switch (meaning.kind) {
    case 'state':
      return { stage: meaning.stage, status: stateStatus(meaning.status, 'reason' in meaning ? meaning.reason : undefined, 'gate' in meaning ? meaning.gate : undefined) }
    case 'escalation':
      return { stage: kindStage(kind), status: { kind: 'waiting-on-you', gate: meaning.gate } }
    case 'pull-request':
    case 'record':
    case 'auto-plan':
      return null
  }
}

export function ticketViewOf(item: Pick<ReconciledItem, 'stage' | 'stages' | 'kind' | 'mergedAt'>): TicketView | null {
  if (item.mergedAt !== null) return { stage: 'merge', status: { kind: 'done' } }
  const key = stageKeyOf(item)
  return key === null ? null : viewOfKey(key, item.kind)
}

export function stageNameOfKey(key: LabelKey): string | null {
  const view = viewOfKey(key, 'issue')
  return view === null ? null : stageNameOf(view)
}

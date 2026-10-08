import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { PipelineItemKind } from '../../../shared/github/types'

export const PHASE_KEYS = ['plan', 'planReview', 'implement', 'review', 'revision', 'merge'] as const

export type PhaseKey = (typeof PHASE_KEYS)[number]

export type PhaseSegmentState = 'finished' | 'current-working' | 'current-attention' | 'complete' | 'pending'

export interface PhaseSegment {
  readonly phase: PhaseKey
  readonly state: PhaseSegmentState
}

// needsHuman/blocked are resolved by item kind in currentPhaseFor, never
// given an entry here.
const STAGE_PHASE: Readonly<Partial<Record<LabelKey, PhaseKey>>> = {
  ready: 'plan',
  planning: 'plan',
  planChangesRequested: 'plan',
  planReview: 'planReview',
  planApproved: 'implement',
  inProgress: 'implement',
  readyForReview: 'review',
  reviewing: 'review',
  needsRevision: 'revision',
  revising: 'revision',
  approved: 'merge',
  refreshBranch: 'merge',
  refreshing: 'merge',
}

function phaseIndex(phase: PhaseKey): number {
  return PHASE_KEYS.indexOf(phase)
}

export interface PhaseModelParams {
  readonly stageKey: LabelKey | null
  readonly kind: PipelineItemKind
  readonly merged: boolean
}

export function currentPhaseFor(params: Pick<PhaseModelParams, 'stageKey' | 'kind'>): PhaseKey | null {
  const { stageKey, kind } = params
  if (stageKey === 'needsHuman' || stageKey === 'blocked') return kind === 'issue' ? 'implement' : 'review'
  return stageKey !== null ? (STAGE_PHASE[stageKey] ?? null) : null
}

export function phaseSegmentsFor(params: PhaseModelParams): readonly PhaseSegment[] {
  const { stageKey, kind, merged } = params
  if (merged) return PHASE_KEYS.map((phase) => ({ phase, state: 'complete' as const }))

  const attention = stageKey === 'needsHuman' || stageKey === 'blocked'
  const current = currentPhaseFor({ stageKey, kind })
  const currentPos = current !== null ? phaseIndex(current) : -1

  return PHASE_KEYS.map((phase, index): PhaseSegment => {
    if (current === null) return { phase, state: 'pending' }
    if (index < currentPos) return { phase, state: 'finished' }
    if (index > currentPos) return { phase, state: 'pending' }
    return { phase, state: attention ? 'current-attention' : 'current-working' }
  })
}

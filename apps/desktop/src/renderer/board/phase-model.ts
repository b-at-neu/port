import type { LabelKey } from '@/utils/labels/vocabulary'
import type { PipelineItemKind } from '@/types/github'
import type { PhaseKey, PhaseSegment } from '@/types/board'
import { PHASE_KEYS } from '@/types/board'
import { paletteOf, type LabelPalette } from '@/utils/labels/defaults'

const SEGMENT_PALETTE: Readonly<Record<PhaseKey, LabelPalette>> = {
  plan: 'plan',
  planReview: 'plan',
  implement: 'implement',
  review: 'review',
  revision: 'revise',
  merge: 'done',
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

interface PhaseModelParams {
  readonly stageKey: LabelKey | null
  readonly kind: PipelineItemKind
  readonly merged: boolean
}

/** `needsHuman`/`blocked` resolve by item kind; every other key is a plain `STAGE_PHASE` lookup. The one place a `LabelKey` becomes a `PhaseKey` — `currentPhaseFor` and `phase-history.ts` both delegate to it. */
export function phaseOfStage(key: LabelKey, kind: PipelineItemKind): PhaseKey | null {
  if (key === 'needsHuman' || key === 'blocked') return kind === 'issue' ? 'implement' : 'review'
  return STAGE_PHASE[key] ?? null
}

export function currentPhaseFor(params: Pick<PhaseModelParams, 'stageKey' | 'kind'>): PhaseKey | null {
  const { stageKey, kind } = params
  return stageKey !== null ? phaseOfStage(stageKey, kind) : null
}

export function phaseSegmentsFor(params: PhaseModelParams): readonly PhaseSegment[] {
  const { stageKey, kind, merged } = params
  if (merged) return PHASE_KEYS.map((phase) => ({ phase, state: 'complete' as const, palette: 'done' as const }))

  const attention = stageKey === 'needsHuman' || stageKey === 'blocked'
  const current = currentPhaseFor({ stageKey, kind })
  const currentPos = current !== null ? phaseIndex(current) : -1
  const currentPalette: LabelPalette | null = attention ? 'needs-you' : stageKey !== null ? paletteOf(stageKey) : null

  return PHASE_KEYS.map((phase, index): PhaseSegment => {
    if (current === null) return { phase, state: 'pending', palette: null }
    if (index < currentPos) return { phase, state: 'finished', palette: SEGMENT_PALETTE[phase] }
    if (index > currentPos) return { phase, state: 'pending', palette: null }
    return { phase, state: attention ? 'current-attention' : 'current-working', palette: currentPalette }
  })
}

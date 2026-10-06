// Pure mapping from a row's current stage label and item kind to the six
// `PhaseBar` segments and each one's own state (#319). No DOM, no copy — a
// segment's own display name is read from `lib/phase.ts`'s `PHASE_NAMES`
// directly by the component that needs it (the bar's one tooltip, the row's
// phase pill), never duplicated here.
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { PipelineItemKind } from '../../../shared/github/types'

/** DESIGN §4's own six segments, in `PhaseBar` order. */
export const PHASE_KEYS = ['plan', 'planReview', 'implement', 'review', 'revision', 'merge'] as const

export type PhaseKey = (typeof PHASE_KEYS)[number]

export type PhaseSegmentState = 'finished' | 'current-working' | 'current-attention' | 'complete' | 'pending'

export interface PhaseSegment {
  readonly phase: PhaseKey
  readonly state: PhaseSegmentState
}

/** Every `LabelKey` that ever appears as a row's own current stage, mapped
 *  to the segment it lights up. `marker`/`autoPlan` are tags, never a
 *  `stage`; `prOpened` is an issue's own terminal hand-off, folded into no
 *  phase (its correlated pull request carries the real one); `needsHuman`
 *  and `blocked` are resolved separately, by item kind, below — never given
 *  an entry here, since the same two keys would otherwise need two
 *  conflicting ones disambiguated only by `kind`. */
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
  /** A pull request's own terminal fact (`item.mergedAt !== null`) — never
   *  reachable for an issue. Wins over everything else: a merged pull
   *  request's whole history reads as finished, regardless of which stage
   *  label it last carried. */
  readonly merged: boolean
}

/** The phase a row's current stage lights up — `null` for an unstaged row
 *  or a stage this table does not recognise. Exported separately from
 *  `phaseSegmentsFor` so `board/sections.ts`'s phase grouping could key off
 *  the same six-phase model if a coarser grouping is ever wanted; today's
 *  section grouping keys off the row's own `LabelKey` instead (`PHASE_NAMES`
 *  already names each one), so this is currently only `phaseSegmentsFor`'s
 *  own helper. */
export function currentPhaseFor(params: Pick<PhaseModelParams, 'stageKey' | 'kind'>): PhaseKey | null {
  const { stageKey, kind } = params
  if (stageKey === 'needsHuman' || stageKey === 'blocked') return kind === 'issue' ? 'implement' : 'review'
  return stageKey !== null ? (STAGE_PHASE[stageKey] ?? null) : null
}

/** The six `PhaseBar` segments for one row, pure over its already-resolved
 *  stage — no phase at all (every segment `pending`) for an unstaged item
 *  (`stageKey === null`) or a stage this table does not recognise. */
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

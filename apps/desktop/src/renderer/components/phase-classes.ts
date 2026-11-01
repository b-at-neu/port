// Tailwind finds a class only as a literal string, so every palette's classes are spelled out here.
import type { PhaseSegment } from '@/types/board'
import type { PhaseTone } from '@/types/components'

type PhasePalette = PhaseTone['palette']

export const PHASE_PILL_CLASS: Readonly<Record<PhasePalette, string>> = {
  plan: 'bg-phase-plan-pill text-phase-plan-pill-foreground',
  implement: 'bg-phase-implement-pill text-phase-implement-pill-foreground',
  review: 'bg-phase-review-pill text-phase-review-pill-foreground',
  revise: 'bg-phase-revise-pill text-phase-revise-pill-foreground',
  refresh: 'bg-phase-refresh-pill text-phase-refresh-pill-foreground',
  'needs-you': 'bg-phase-needs-you-pill text-phase-needs-you-pill-foreground',
  done: 'bg-phase-done-pill text-phase-done-pill-foreground',
  unstaged: 'bg-idle-pill text-idle-pill-foreground',
}

export const PHASE_DOT_CLASS: Readonly<Record<PhasePalette, string>> = {
  plan: 'bg-phase-plan-dot',
  implement: 'bg-phase-implement-dot',
  review: 'bg-phase-review-dot',
  revise: 'bg-phase-revise-dot',
  refresh: 'bg-phase-refresh-dot',
  'needs-you': 'bg-phase-needs-you-dot',
  done: 'bg-phase-done-dot',
  unstaged: 'bg-idle-dot',
}

export const PHASE_RING_CLASS: Readonly<Record<PhasePalette, string>> = {
  plan: 'border border-phase-plan-dot',
  implement: 'border border-phase-implement-dot',
  review: 'border border-phase-review-dot',
  revise: 'border border-phase-revise-dot',
  refresh: 'border border-phase-refresh-dot',
  'needs-you': 'border border-phase-needs-you-dot',
  done: 'border border-phase-done-dot',
  unstaged: 'border border-idle-dot',
}

export const PHASE_DOT_ON_PILL_CLASS = 'bg-current'

export const PHASE_RING_ON_PILL_CLASS = 'border border-current'

const PHASE_SEGMENT_FINISHED_CLASS: Readonly<Record<PhasePalette, string>> = {
  plan: 'bg-phase-plan-dot/40',
  implement: 'bg-phase-implement-dot/40',
  review: 'bg-phase-review-dot/40',
  revise: 'bg-phase-revise-dot/40',
  refresh: 'bg-phase-refresh-dot/40',
  'needs-you': 'bg-phase-needs-you-dot/40',
  done: 'bg-phase-done-dot/40',
  unstaged: 'bg-idle-pill',
}

/** A decided phase takes its palette's dot at 40%, the current one the full dot, a pending one the neutral `border`. */
export function segmentClass(segment: PhaseSegment): string {
  if (segment.palette === null) return 'bg-border'
  return segment.state === 'finished' || segment.state === 'complete' ? PHASE_SEGMENT_FINISHED_CLASS[segment.palette] : PHASE_DOT_CLASS[segment.palette]
}

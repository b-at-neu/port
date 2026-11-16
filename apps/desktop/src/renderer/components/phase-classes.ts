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

/** A kanban column header's bottom rule. */
export const PHASE_RULE_CLASS: Readonly<Record<PhasePalette, string>> = {
  plan: 'border-b-2 border-phase-plan-dot',
  implement: 'border-b-2 border-phase-implement-dot',
  review: 'border-b-2 border-phase-review-dot',
  revise: 'border-b-2 border-phase-revise-dot',
  refresh: 'border-b-2 border-phase-refresh-dot',
  'needs-you': 'border-b-2 border-phase-needs-you-dot',
  done: 'border-b-2 border-phase-done-dot',
  unstaged: 'border-b-2 border-idle-dot',
}

/** A kanban card's left edge. */
export const PHASE_EDGE_CLASS: Readonly<Record<PhasePalette, string>> = {
  plan: 'border-l-4 border-l-phase-plan-dot',
  implement: 'border-l-4 border-l-phase-implement-dot',
  review: 'border-l-4 border-l-phase-review-dot',
  revise: 'border-l-4 border-l-phase-revise-dot',
  refresh: 'border-l-4 border-l-phase-refresh-dot',
  'needs-you': 'border-l-4 border-l-phase-needs-you-dot',
  done: 'border-l-4 border-l-phase-done-dot',
  unstaged: 'border-l-4 border-l-idle-dot',
}

export const PHASE_DOT_ON_PILL_CLASS = 'bg-current'

export const PHASE_RING_ON_PILL_CLASS = 'border border-current'

/** Past is one neutral, future a dimmer one, a merged item the full `done` dot, and the current phase its own palette's dot. */
export function segmentClass(segment: PhaseSegment): string {
  switch (segment.state) {
    case 'pending':
      return 'bg-segment-future'
    case 'finished':
      return 'bg-segment-past'
    case 'complete':
      return PHASE_DOT_CLASS.done
    case 'current-working':
    case 'current-attention':
      return segment.palette === null ? 'bg-segment-future' : PHASE_DOT_CLASS[segment.palette]
  }
}

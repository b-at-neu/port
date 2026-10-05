// No runtime imports: a pin checks this against the design doc directly.
import type { LabelKey } from '../../../shared/labels/vocabulary'

/** `null` means the role is never shown as a phase. */
export const PHASE_NAMES: Readonly<Record<LabelKey, string | null>> = {
  marker: null,
  autoPlan: null,
  ready: 'Queued',
  planning: 'Planning',
  planReview: 'Plan review',
  planChangesRequested: 'Replanning',
  planApproved: 'Plan approved',
  inProgress: 'Implementing',
  prOpened: null,
  readyForReview: 'Waiting for review',
  reviewing: 'Reviewing',
  needsRevision: 'Needs revision',
  revising: 'Revising',
  approved: 'Ready to merge',
  needsHuman: 'Needs you',
  blocked: 'Blocked',
  refreshBranch: 'Refreshing',
  refreshing: 'Refreshing',
}

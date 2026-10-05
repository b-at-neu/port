// DESIGN §6's phase-display-name table, as data (#316). Phase names come
// from the label *role*, never the label string, so a repository that
// renames its labels still reads the same. No runtime imports: the
// `desktop-shell` pin imports this module directly to check it against the
// table in both directions, and a runtime import would pull `main/` into
// that check.
import type { LabelKey } from '../../../shared/labels/vocabulary'

/** `null` means the role is never shown as a phase: `marker`/`autoPlan` are
 *  markers, not phases, and `prOpened` reads from its pull request's own
 *  label from there on (DESIGN §6). */
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

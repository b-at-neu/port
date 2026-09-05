// The four-rung correlation ladder, pure and I/O-free so it is directly
// unit-testable and directly comparable to the reclaimer's own copy
// (`plugins/port/templates/worktrees.mjs`'s `correlate`). Byte-for-byte the
// same ladder, first hit wins (PIPELINE.md → "Worktree lifecycle" →
// "Correlation"); the shared case table (`correlation.cases.json`) is what
// pins the two together, run by both `correlate.test.ts` here and
// `scripts/checks/desktop-local.mjs` over the reclaimer's export.
import type { CorrelationRung, WorktreeCorrelation } from '../../shared/local/types'

export interface CorrelationInput {
  readonly upstreamMergeRef: string | null
  readonly branch: string | null
  readonly dirBasename: string | null
  readonly headSubject: string | null
}

const UPSTREAM_PATTERN = /^refs\/heads\/(\d+)-/
const BRANCH_PATTERN = /^(\d+)-/
const DIR_PATTERN = /^impl-(\d+)$/
const SUBJECT_PATTERN = /^#(\d+)\b/

/** `#0` is never a real issue/pull-request number in this pipeline, so it is
 *  excluded at every rung rather than accepted as a correlation. */
function positiveMatch(pattern: RegExp, value: string | null): number | null {
  const match = pattern.exec(value ?? '')
  if (!match) return null
  const number = Number(match[1])
  return number > 0 ? number : null
}

/** First hit wins. Deliberately redundant across rungs — a detached
 *  worktree carries no upstream and falls through to the head-subject
 *  rung. */
export function correlate(input: CorrelationInput): WorktreeCorrelation | null {
  const upstream = positiveMatch(UPSTREAM_PATTERN, input.upstreamMergeRef)
  if (upstream !== null) return { number: upstream, rung: 'upstream-branch' as CorrelationRung }

  const branch = positiveMatch(BRANCH_PATTERN, input.branch)
  if (branch !== null) return { number: branch, rung: 'branch-name' as CorrelationRung }

  const dir = positiveMatch(DIR_PATTERN, input.dirBasename)
  if (dir !== null) return { number: dir, rung: 'directory-basename' as CorrelationRung }

  const subject = positiveMatch(SUBJECT_PATTERN, input.headSubject)
  if (subject !== null) return { number: subject, rung: 'head-subject' as CorrelationRung }

  return null
}

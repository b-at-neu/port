// Byte-for-byte the same ladder as the reclaimer's own copy; `correlation.cases.json` pins the two together.
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

/** First hit wins. Deliberately redundant: a detached worktree falls through to the head-subject rung. */
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

// Pure: reads GitHub evidence and decides which hand-back a finished stage already implies. Fails toward today's path — missing, partial or ambiguous evidence adopts nothing.
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { ClosingPullRequest, ReviewNode } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import type { TickClaim, TickObservation } from '@/types/tick'
import { isContradictory } from '@/main/tick/observe'

type Adoption = Extract<TickObservation, { readonly kind: 'adopt' }>

const CODE_REVIEW_PREFIX = '## Code Review'
const VERDICT_SEPARATOR = ' · '

/** Claim classes the matched and session-required paths already own; every other class may be adopted. */
const ADOPTABLE_CLASSES: readonly TickClaim['class'][] = ['no-record', 'suspect', 'stalled-confirmed', 'capped', 'interrupted']

function newestCodeReview(reviews: readonly ReviewNode[] | null): ReviewNode | null {
  const codeReviews = (reviews ?? []).filter((r) => r.body.startsWith(CODE_REVIEW_PREFIX))
  if (codeReviews.length === 0) return null
  return codeReviews.reduce((a, b) => (a.submittedAt > b.submittedAt ? a : b))
}

/** The verdict a `## Code Review — Cycle <n> · <verdict>` title names, or `null` for any other shape. */
function verdictOf(review: ReviewNode): string | null {
  const title = review.body.split('\n')[0] ?? ''
  const at = title.lastIndexOf(VERDICT_SEPARATOR)
  return at === -1 ? null : title.slice(at + VERDICT_SEPARATOR.length).trim()
}

/** The newest `## Code Review` on the current head when it approved — the verdict a held review adopts instead of escalating. */
export function heldVerdictOf(item: Pick<ReconciledItem, 'reviews' | 'headRefOid'>): 'approved' | null {
  const newest = newestCodeReview(item.reviews)
  if (newest === null || item.headRefOid === null || newest.commitOid !== item.headRefOid) return null
  return verdictOf(newest) === 'approved' ? 'approved' : null
}

/** The one open pull request on this issue's own `<n>-` branch, or `null` for none or several — two is a decision for a person. */
export function ownBranchPullRequestOf(item: Pick<ReconciledItem, 'number' | 'closingPullRequests'>): ClosingPullRequest | null {
  const open = (item.closingPullRequests ?? []).filter((pr) => pr.state === 'OPEN' && (pr.headRefName ?? '').startsWith(`${String(item.number)}-`))
  const [only] = open
  return open.length === 1 && only !== undefined ? only : null
}

/** What a `planApproved` issue that already has its pull request adopts instead of dispatching an impl session. */
export function openPullRequestAdoption(item: ReconciledItem): Adoption | null {
  const pr = ownBranchPullRequestOf(item)
  if (pr === null) return null
  return { kind: 'adopt', number: item.number, itemKind: item.kind, agent: 'impl', trigger: 'planApproved', handback: { token: 'pr-opened', arg: `#${String(pr.number)}` }, evidence: 'pr' }
}

/** What a `readyForReview` pull request whose head already has an approving review adopts instead of a second review. */
export function heldVerdictAdoption(item: ReconciledItem): Adoption | null {
  if (heldVerdictOf(item) === null) return null
  return { kind: 'adopt', number: item.number, itemKind: item.kind, agent: 'review', trigger: 'readyForReview', handback: { token: 'approved', arg: null }, evidence: 'held-verdict' }
}

function claimedAt(item: ReconciledItem, inFlight: LabelKey): string | null {
  return item.stageHistory.findLast((entry) => entry.key === inFlight)?.at ?? null
}

function adoptionOf(item: ReconciledItem, claim: TickClaim): Pick<Adoption, 'agent' | 'trigger' | 'handback' | 'evidence'> | null {
  const at = claimedAt(item, claim.inFlight)
  if (at === null) return null
  switch (claim.inFlight) {
    case 'planning': {
      if (item.planPresent !== true) return null
      const trigger = item.stageHistory.findLast((entry) => (entry.key === 'ready' || entry.key === 'planChangesRequested') && entry.at <= at)?.key
      return trigger === 'ready' ? { agent: 'plan', trigger, handback: { token: 'plan-written', arg: null }, evidence: 'plan' } : null
    }
    case 'inProgress': {
      const pr = ownBranchPullRequestOf(item)
      return pr === null ? null : { agent: 'impl', trigger: 'planApproved', handback: { token: 'pr-opened', arg: `#${String(pr.number)}` }, evidence: 'pr' }
    }
    case 'reviewing': {
      const newest = newestCodeReview(item.reviews)
      if (newest === null || item.headRefOid === null || newest.commitOid !== item.headRefOid || newest.submittedAt < at) return null
      // A review title spells the verdict with spaces; the hand-back token spells it with hyphens.
      const token = verdictOf(newest)?.replaceAll(' ', '-')
      return token === 'approved' || token === 'needs-revision' ? { agent: 'review', trigger: 'readyForReview', handback: { token, arg: null }, evidence: 'review' } : null
    }
    case 'revising': {
      const newest = newestCodeReview(item.reviews)
      if (newest === null || item.headRefOid === null || newest.commitOid === item.headRefOid) return null
      return { agent: 'revise', trigger: 'needsRevision', handback: { token: 'revised', arg: null }, evidence: 'head-moved' }
    }
    default:
      return null
  }
}

/** At most one adoption per claim that no live session holds, in claim order. */
export function adoptionsOf(params: { readonly items: readonly ReconciledItem[]; readonly claims: readonly TickClaim[]; readonly viewer: string }): readonly Adoption[] {
  const itemByNumber = new Map(params.items.map((item) => [item.number, item] as const))
  const out: Adoption[] = []
  for (const claim of params.claims) {
    if (!ADOPTABLE_CLASSES.includes(claim.class)) continue
    const item = itemByNumber.get(claim.number)
    if (item === undefined || !item.assignees.includes(params.viewer) || isContradictory(item)) continue
    const adoption = adoptionOf(item, claim)
    if (adoption !== null) out.push({ kind: 'adopt', number: claim.number, itemKind: claim.kind, ...adoption })
  }
  return out
}

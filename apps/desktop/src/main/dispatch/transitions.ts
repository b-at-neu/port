// Pure: the (stage, event) → label plan table. No I/O — `main/actions/stage.ts` applies what this plans.
import type { PipelineItemKind } from '@/types/github'
import type { StageEvent, StageMode, StagePlannedWrite, StageTransition } from '@/types/stage-labels'
import type { StageHandback } from '@/types/stage-session'
import type { HandoffRefusal, StageAgent } from '@/types/tick'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import { inFlightKeyFor } from '@/main/tick/routing'
import { RETRY_TRIGGER } from '../../../../../scripts/port-tick/liveness'

/** The closed vocabulary of `HANDBACK:` tokens each mode may end with — pinned both directions against the bundled agents by `desktop-stage-labels`. */
export const HANDBACK_TOKENS: Readonly<Record<StageMode, readonly string[]>> = {
  plan: ['plan-written'],
  impl: ['pr-opened'],
  review: ['approved', 'needs-revision', 'checks-pending', 'rebase-required', 'head-moved'],
  revise: ['revised', 'escalated'],
  refresh: ['refreshed', 'escalated'],
}

export function stageModeFor(agent: StageAgent, trigger: LabelKey): StageMode {
  return trigger === 'refreshBranch' ? 'refresh' : agent
}

export function itemKindFor(mode: StageMode): PipelineItemKind {
  return mode === 'plan' || mode === 'impl' ? 'issue' : 'pull-request'
}

const CLAIM_SOURCES: Readonly<Record<StageMode, readonly LabelKey[]>> = {
  plan: ['ready', 'planChangesRequested'],
  impl: ['planApproved'],
  review: ['readyForReview'],
  revise: ['needsRevision'],
  refresh: ['refreshBranch'],
}

// Labels a refresh may find beside its own: a sanctioned `approved`, and one leftover trigger a claim clears.
const REFRESH_CLAIM_TOLERATED: readonly LabelKey[] = ['approved', 'readyForReview', 'needsRevision']

interface TransitionParams {
  readonly event: StageEvent
  readonly mode: StageMode
  /** The item's observed role-bearing label keys, markers excluded. */
  readonly observed: readonly LabelKey[]
  /** The named pull request's observed role-bearing keys, read only for a `pr-opened` hand-back. */
  readonly prObserved?: readonly LabelKey[]
  readonly approvalGate: boolean
}

interface Match {
  readonly source: LabelKey
  readonly tolerated: readonly LabelKey[]
}

/** Exactly one of `sources` must be observed, and nothing else beyond `tolerated`. */
function matchSource(observed: readonly LabelKey[], sources: readonly LabelKey[], tolerated: readonly LabelKey[] = []): Match | null {
  const present = sources.filter((s) => observed.includes(s))
  if (present.length !== 1) return null
  const [source] = present
  if (source === undefined) return null
  const others = observed.filter((key) => key !== source)
  if (others.some((key) => !tolerated.includes(key))) return null
  return { source, tolerated: others }
}

function write(itemKind: PipelineItemKind, add: readonly LabelKey[], remove: readonly LabelKey[], action: string, numberFrom: 'item' | 'arg' = 'item'): StageTransition {
  const planned: StagePlannedWrite = { itemKind, numberFrom, add, remove, action }
  return { kind: 'write', writes: [planned] }
}

const MOVED: StageTransition = { kind: 'refused', reason: 'moved' }

function claim(mode: StageMode, observed: readonly LabelKey[]): StageTransition {
  const itemKind = itemKindFor(mode)
  if (mode === 'refresh') {
    const match = matchSource(observed, CLAIM_SOURCES.refresh, REFRESH_CLAIM_TOLERATED)
    if (match === null || match.tolerated.filter((key) => key !== 'approved').length > 1) return MOVED
    return write(itemKind, ['refreshing'], ['refreshBranch', ...match.tolerated.filter((key) => key !== 'approved')], 'stage-claim')
  }
  const match = matchSource(observed, CLAIM_SOURCES[mode])
  if (match === null) return MOVED
  const inFlight = inFlightKeyFor(mode, match.source)
  const add: readonly LabelKey[] = mode === 'plan' && match.source === 'ready' ? [inFlight, 'marker'] : [inFlight]
  return write(itemKind, add, [match.source], 'stage-claim')
}

function reset(mode: StageMode, observed: readonly LabelKey[], action: string): StageTransition {
  const inFlight = mode === 'refresh' ? 'refreshing' : inFlightKeyFor(mode, 'ready')
  const retry = RETRY_TRIGGER[inFlight] as LabelKey | undefined
  if (retry === undefined) return MOVED
  const sources: readonly LabelKey[] = mode === 'impl' ? [inFlight, 'blocked'] : [inFlight]
  const match = matchSource(observed, sources, mode === 'refresh' ? ['approved'] : [])
  if (match === null) return MOVED
  return write(itemKindFor(mode), [retry], [match.source], action)
}

function blocked(mode: StageMode, observed: readonly LabelKey[]): StageTransition {
  if (mode !== 'impl') return { kind: 'none' }
  const match = matchSource(observed, ['inProgress'])
  if (match === null) return MOVED
  return write('issue', ['blocked'], ['inProgress'], 'stage-blocked')
}

function resumedTurn(mode: StageMode, observed: readonly LabelKey[]): StageTransition {
  if (mode !== 'impl') return { kind: 'none' }
  const match = matchSource(observed, ['blocked'])
  if (match === null) return MOVED
  return write('issue', ['inProgress'], ['blocked'], 'stage-unblocked')
}

/** A pull request number, with or without a leading hash; nothing else. */
export function pullRequestNumberOf(arg: string | null): number | null {
  if (arg === null) return null
  const match = /^#?(\d+)$/.exec(arg)
  if (match === null) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** The hand-back a completed outcome or an adoption carries, `undefined` for any other event. */
function handbackOf(event: StageEvent): StageHandback | null | undefined {
  if (event.kind === 'adopt') return event.handback
  return event.kind === 'outcome' && event.outcome === 'completed' ? event.handback : undefined
}

/** Why a finished stage's `HANDBACK:` line cannot be acted on — checked before any read, since it never changes. An adopted hand-back's plan is already in the issue body, so it needs no plan file. */
export function handbackRefusal(event: StageEvent, mode: StageMode): HandoffRefusal | null {
  const handback = handbackOf(event)
  if (handback === undefined) return null
  if (handback === null) return 'no-handback'
  if (!HANDBACK_TOKENS[mode].includes(handback.token)) return 'unknown-handback'
  if (mode === 'impl' && pullRequestNumberOf(handback.arg) === null) return 'unknown-handback'
  if (mode === 'refresh' && handback.token === 'refreshed' && handback.arg !== 'clean' && handback.arg !== 'resolved') return 'unknown-handback'
  if (event.kind === 'outcome' && mode === 'plan' && handback.token === 'plan-written') {
    if (event.plan === null || event.plan.kind === 'missing') return 'no-plan-file'
    if (event.plan.kind === 'empty') return 'empty-plan-file'
  }
  return null
}

/** The in-flight key a mode's hand-back settles, and the trigger a liveness reset may already have put back in its place. */
function sourcesOf(inFlight: LabelKey): readonly LabelKey[] {
  const retry = RETRY_TRIGGER[inFlight] as LabelKey | undefined
  return retry === undefined ? [inFlight] : [inFlight, retry]
}

/** Whether an event writes anything at all — the rest wait for the session to carry on or for Resume/Restart. */
export function eventWrites(event: StageEvent, mode: StageMode): boolean {
  if (event.kind !== 'outcome') return true
  if (event.outcome === 'blocked') return mode === 'impl'
  return event.outcome === 'completed' || event.outcome === 'error'
}

function prOpened(observed: readonly LabelKey[], prObserved: readonly LabelKey[], approvalGate: boolean, actionPrefix: string): StageTransition {
  const match = matchSource(observed, ['inProgress', 'blocked', 'planApproved'])
  if (match === null) return MOVED
  if (prObserved.some((key) => key !== 'readyForReview')) return MOVED
  const prAdd: readonly LabelKey[] = approvalGate ? ['readyForReview', 'marker'] : ['readyForReview']
  const action = `${actionPrefix}-pr-opened`
  return {
    kind: 'write',
    writes: [
      { itemKind: 'pull-request', numberFrom: 'arg', add: prAdd, remove: [], action },
      { itemKind: 'issue', numberFrom: 'item', add: ['prOpened'], remove: [match.source], action },
    ],
  }
}

function refreshed(arg: string | null, observed: readonly LabelKey[], action: string): StageTransition {
  const match = matchSource(observed, sourcesOf('refreshing'), ['approved'])
  if (match === null) return MOVED
  const approved = match.tolerated.includes('approved')
  const clean = arg === 'clean'
  const refreshAction = `${action}-${clean ? 'clean' : 'resolved'}`
  if (clean) return write('pull-request', approved ? [] : ['readyForReview'], [match.source], refreshAction)
  return write('pull-request', ['readyForReview'], approved ? [match.source, 'approved'] : [match.source], refreshAction)
}

/** A write that moves `source` to `target`, or nothing when a reset already put the item there. */
function move(itemKind: PipelineItemKind, target: LabelKey, source: LabelKey, action: string): StageTransition {
  return source === target ? { kind: 'none' } : write(itemKind, [target], [source], action)
}

const REVIEW_TARGET: Readonly<Record<string, LabelKey>> = { approved: 'approved', 'needs-revision': 'needsRevision', 'checks-pending': 'needsHuman', 'rebase-required': 'refreshBranch', 'head-moved': 'readyForReview' }

function handbackTransition(mode: StageMode, handback: StageHandback, params: TransitionParams, actionPrefix: string): StageTransition {
  const { observed, approvalGate } = params
  const itemKind = itemKindFor(mode)
  const action = `${actionPrefix}-${handback.token}`
  switch (`${mode}:${handback.token}`) {
    case 'plan:plan-written': {
      const match = matchSource(observed, sourcesOf('planning'))
      return match === null ? MOVED : write(itemKind, ['planReview'], [match.source], action)
    }
    case 'impl:pr-opened':
      return prOpened(observed, params.prObserved ?? [], approvalGate, actionPrefix)
    case 'review:approved':
    case 'review:needs-revision':
    case 'review:checks-pending':
    case 'review:rebase-required':
    case 'review:head-moved': {
      const match = matchSource(observed, sourcesOf('reviewing'))
      const target = REVIEW_TARGET[handback.token]
      return match === null || target === undefined ? MOVED : move(itemKind, target, match.source, action)
    }
    case 'revise:revised': {
      const match = matchSource(observed, sourcesOf('revising'))
      return match === null ? MOVED : move(itemKind, 'readyForReview', match.source, action)
    }
    case 'revise:escalated': {
      const match = matchSource(observed, sourcesOf('revising'))
      return match === null ? MOVED : write(itemKind, ['needsHuman'], [match.source], action)
    }
    case 'refresh:refreshed':
      return refreshed(handback.arg, observed, action)
    case 'refresh:escalated': {
      const match = matchSource(observed, sourcesOf('refreshing'), ['approved'])
      if (match === null) return MOVED
      return write(itemKind, ['needsHuman'], match.tolerated.includes('approved') ? [match.source, 'approved'] : [match.source], action)
    }
    default:
      return { kind: 'refused', reason: 'unknown-handback' }
  }
}

/** What the table plans for one stage event. A write is planned only when the observed set matches a row exactly; any other set is `moved`, and nothing is guessed. */
export function transitionFor(params: TransitionParams): StageTransition {
  const { event, mode, observed } = params
  switch (event.kind) {
    case 'claim':
      return claim(mode, observed)
    case 'rollback':
      return reset(mode, observed, 'stage-rollback')
    case 'resumed-turn':
      return resumedTurn(mode, observed)
    case 'adopt': {
      const refusal = handbackRefusal(event, mode)
      return refusal === null ? handbackTransition(mode, event.handback, params, 'stage-adopt') : { kind: 'refused', reason: refusal }
    }
    case 'outcome':
      switch (event.outcome) {
        case 'completed': {
          const refusal = handbackRefusal(event, mode)
          if (refusal !== null || event.handback === null) return { kind: 'refused', reason: refusal ?? 'no-handback' }
          return handbackTransition(mode, event.handback, params, 'stage-handback')
        }
        case 'blocked':
          return blocked(mode, observed)
        case 'error':
          return reset(mode, observed, 'stage-error-reset')
        case 'questions':
        case 'interrupted':
        case 'usage-limit':
          return { kind: 'none' }
      }
  }
}

/** The exact precondition for one write, mirroring `observation.ts`: the observed role-bearing set is present, every other role-bearing key is absent unless the write adds it, and the assignees are exactly as read. */
export function expectFor(observed: readonly LabelKey[], vocabulary: LabelVocabulary, add: readonly LabelKey[], assignees: readonly string[]) {
  const allRoleBearing = vocabulary.labels.filter((l) => l.role !== 'marker').map((l) => l.key)
  const absent = allRoleBearing.filter((key) => !observed.includes(key) && !add.includes(key))
  return { present: observed, absent, assignees: { kind: 'exactly' as const, logins: assignees } }
}

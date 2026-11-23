import { describe, expect, it } from 'vitest'
import { applyObservation } from '@/main/actions/observe'
import { endedIntents, fastEndIntent, FAST_END_MS, handoffRefusalIntent, launchFailedIntent, observationIntent, signatureOf, stageHandbackIntent } from '@/main/incidents/raise'
import type { WriteObservation } from '@/types/dispatch'
import { INCIDENT_BUCKETS, type IncidentBucket } from '@/types/incidents'
import type { StageOutcome } from '@/types/stage-session'
import { ENTRY, item, writerRig } from './fixtures'

const PLAN = { add: ['needsHuman'], remove: ['readyForReview'], action: 'observe-zero-diff' } as const
const RECORD = { agent: 'impl', trigger: 'planApproved', sessionKey: 'hosted-1', claudeSessionId: 'claude-1', at: '2026-11-16T10:00:00.000Z' } as const

function outcome(kind: StageOutcome['kind'], detail: string | null = null): StageOutcome {
  return { kind, detail, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null }
}

function bucketsOf(intents: readonly { readonly bucket: IncidentBucket }[]): readonly IncidentBucket[] {
  return intents.map((intent) => intent.bucket)
}

// Typed `satisfies Record<IncidentBucket, …>`, so a bucket added without a raising case fails the typecheck.
const RAISED = {
  'stale-snapshot': async () => {
    const rig = writerRig({ number: 789, writeHead: 'a7e3b21' })
    const observation: WriteObservation = { kind: 'zero-diff', number: 789, itemKind: 'pull-request', count: 2, headRefOid: 'f19c6d5' }
    await applyObservation({ entry: ENTRY, item: item(), observation, snapshotAt: 'tick-1', auditDir: '/audit', scratchDir: '/scratch' }, { writeState: rig.writeState, postComment: () => Promise.resolve({ kind: 'no-op' }) })
    return rig.incidents.map((draft) => draft.bucket)
  },
  'liveness-reset': () => {
    const observation: WriteObservation = { kind: 'liveness-reset', number: 789, itemKind: 'pull-request', inFlight: 'inProgress', retryKey: 'planApproved' }
    return bucketsOf([observationIntent(observation, item(), { add: ['planApproved'], remove: ['inProgress'], action: 'observe-liveness-reset' }, null)].filter((intent) => intent !== null))
  },
  'duplicate-head': () => {
    const observation: WriteObservation = { kind: 'zero-diff', number: 789, itemKind: 'pull-request', count: 2, headRefOid: 'f19c6d5' }
    return bucketsOf([observationIntent(observation, item(), PLAN, null)].filter((intent) => intent !== null))
  },
  'existing-work': () => bucketsOf([stageHandbackIntent({ itemKind: 'issue', numberFrom: 'item', add: ['blocked'], remove: ['inProgress'], action: 'stage-handback-blocked' }, 'impl', 749, item({ kind: 'issue', number: 749, closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-the-fix' }] }), null)].filter((intent) => intent !== null)),
  'leftover-worktree': () => bucketsOf([launchFailedIntent(RECORD, 'leftover-worktree')]),
  'network-interrupt': () => bucketsOf(endedIntents(RECORD, outcome('interrupted', 'getaddrinfo ENOTFOUND api.anthropic.com'), Date.parse('2026-11-16T11:00:00.000Z'))),
  'refused-write': () => bucketsOf([handoffRefusalIntent({ agent: 'impl', sessionKey: 'hosted-1', trigger: 'planApproved' }, 'write-failed', 3, true)]),
  'launch-failed': () => bucketsOf([launchFailedIntent(RECORD, 'start')]),
  escalation: () => {
    const observation: WriteObservation = { kind: 'cycle-cap', number: 789, itemKind: 'pull-request', count: 5, cap: 5 }
    return bucketsOf([observationIntent(observation, item(), { add: ['needsHuman'], remove: ['needsRevision'], action: 'observe-cycle-cap' }, null)].filter((intent) => intent !== null))
  },
  unknown: () => bucketsOf(endedIntents(RECORD, outcome('error', 'boom'), Date.parse('2026-11-16T11:00:00.000Z'))),
} satisfies Record<IncidentBucket, () => readonly IncidentBucket[] | Promise<readonly IncidentBucket[]>>

describe('every bucket has a raising site', () => {
  it.each(INCIDENT_BUCKETS)('raises %s', async (bucket) => {
    expect(await RAISED[bucket]()).toContain(bucket)
  })
})

describe('signatureOf', () => {
  it('joins bucket, stage and condition, so a recurrence shares one signature', () => {
    expect(signatureOf('stale-snapshot', 'needsHuman', 'head-moved')).toBe('stale-snapshot:needsHuman:head-moved')
  })
})

describe('observationIntent', () => {
  it('raises nothing for a routine observation', () => {
    const observation: WriteObservation = { kind: 'plan-missing', number: 52, itemKind: 'issue' }
    expect(observationIntent(observation, item(), { add: ['ready'], remove: ['planReview'], action: 'observe-plan-missing' }, null)).toBeNull()
  })

  it('raises nothing when an approval withdrawal goes back to revision, and an escalation when it goes to a human', () => {
    const red = [{ name: 'ci', conclusion: 'FAILURE', url: null }]
    const toRevision: WriteObservation = { kind: 'withdraw-approval', number: 789, itemKind: 'pull-request', headRefOid: 'f19c6d5', red, route: 'revise' }
    const toHuman: WriteObservation = { ...toRevision, route: 'human' }
    const plan = { add: ['needsHuman'], remove: ['approved'], action: 'observe-withdraw-approval' }
    expect(observationIntent(toRevision, item(), plan, null)).toBeNull()
    expect(observationIntent(toHuman, item(), plan, null)).toMatchObject({ bucket: 'escalation', condition: 'withdraw-approval' })
  })

  it('keeps the observation kind out of the signature condition for a stage that did not move', () => {
    const observation: WriteObservation = { kind: 'refresh-stuck', number: 789, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'f19c6d5', count: 2 }
    expect(observationIntent(observation, item(), { add: ['needsHuman'], remove: ['readyForReview'], action: 'observe-refresh-stuck' }, 'tick-1')).toMatchObject({ bucket: 'escalation', stage: 'needsHuman', condition: 'refresh-stuck', inputs: { observedHead: 'f19c6d5', snapshotAt: 'tick-1' } })
  })
})

describe('stageHandbackIntent', () => {
  const blocked = { itemKind: 'issue', numberFrom: 'item', add: ['blocked'], remove: ['inProgress'], action: 'stage-handback-blocked' } as const

  it('makes the open own-branch pull request the subject of an existing-work incident', () => {
    const issue = item({ kind: 'issue', number: 749, closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-the-fix' }] })
    expect(stageHandbackIntent(blocked, 'impl', 749, issue, null)).toMatchObject({ bucket: 'existing-work', condition: 'pr-open', subject: { kind: 'pull-request', number: 780 }, inputs: { issue: 749 } })
  })

  it('is an escalation without that pull request, and nothing for a write that adds neither gate', () => {
    expect(stageHandbackIntent(blocked, 'impl', 749, item({ kind: 'issue', number: 749 }), null)).toMatchObject({ bucket: 'escalation', stage: 'blocked', condition: 'stage-handback-blocked' })
    expect(stageHandbackIntent({ ...blocked, add: ['prOpened'] }, 'impl', 749, null, null)).toBeNull()
  })
})

describe('session incidents', () => {
  it('raises launch-failed ended-fast for a session that lived under the threshold, and nothing after it', () => {
    const startedAt = Date.parse(RECORD.at)
    expect(fastEndIntent(RECORD, 'completed', null, startedAt + FAST_END_MS - 1)).toMatchObject({ bucket: 'launch-failed', condition: 'ended-fast' })
    expect(fastEndIntent(RECORD, 'completed', null, startedAt + FAST_END_MS)).toBeNull()
  })

  it('classifies a stop by its reason and never carries the detail text', () => {
    const later = Date.parse('2026-11-16T11:00:00.000Z')
    const [network] = endedIntents(RECORD, outcome('interrupted', 'ECONNRESET secret-token'), later)
    expect(network).toMatchObject({ bucket: 'network-interrupt', condition: 'network' })
    expect(JSON.stringify(network)).not.toContain('secret-token')
    expect(endedIntents(RECORD, outcome('usage-limit'), later)).toMatchObject([{ bucket: 'unknown', condition: 'usage-limit' }])
    expect(endedIntents(RECORD, outcome('error', 'hand-back settle failed: boom'), later)).toMatchObject([{ bucket: 'unknown', condition: 'settle-failed' }])
    expect(endedIntents(RECORD, outcome('completed'), later)).toEqual([])
  })
})

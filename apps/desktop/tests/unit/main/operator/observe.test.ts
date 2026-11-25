import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'
import type { ApplyObservationParams, ReadyEntry } from '@/types/actions'
import { applyObservation } from '@/main/pipeline/operator/observe'
import type { PostCommentParams, WriteStateParams } from '@/types/writes'
import type { GatePreflightFetch } from '@/types/github'

const REPO_ID = 'repo-1' as unknown as RepoId
const APPLIED = { kind: 'applied', argv: [] } satisfies WriteOutcome

const ENTRY: ReadyEntry = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready',
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: resolveVocabulary({}),
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

function item(comments: ReconciledItem['comments']): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: 'acme/widgets',
    kind: 'pull-request',
    number: 52,
    title: 'a pull request',
    url: 'https://github.com/acme/widgets/pull/52',
    assignees: ['op'],
    stage: 'trigger',
    stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'gated',
    statusEvidence: null,
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    workSessions: [],
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    stageHistory: [],
    matchedKeys: ['readyForReview'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: 'abc1234',
    mergeable: 'MERGEABLE',
    reviews: null,
    comments,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
  }
}

function params(comments: ReconciledItem['comments']): ApplyObservationParams {
  return {
    entry: ENTRY,
    item: item(comments),
    observation: { kind: 'zero-diff', number: 52, itemKind: 'pull-request', count: 2, headRefOid: 'abc1234' },
    auditDir: '/audit',
    scratchDir: '/scratch',
  }
}

function deps(): { readonly posted: PostCommentParams[]; readonly labelCalls: () => number; readonly value: Parameters<typeof applyObservation>[1] } {
  const posted: PostCommentParams[] = []
  let labels = 0
  return {
    posted,
    labelCalls: () => labels,
    value: {
      writeState: () => {
        labels++
        return Promise.resolve(APPLIED)
      },
      postComment: (p) => {
        posted.push(p)
        return Promise.resolve(APPLIED)
      },
      fetchGatePreflight: () => {
        throw new Error('fetchGatePreflight must not be called for this observation')
      },
    },
  }
}

describe('applyObservation — escalation dedup', () => {
  it('posts the first escalation on a head', async () => {
    const d = deps()
    const result = await applyObservation(params([]), d.value)
    expect(d.posted).toHaveLength(1)
    expect(result.comment).toEqual(APPLIED)
  })

  it('applies the labels but skips the comment when the newest escalation already carries this cause on this head', async () => {
    const d = deps()
    const comments = [{ body: '## Pipeline Escalation\nEarlier.\n<!-- port:escalation sha-cap abc1234 -->', createdAt: '2026-01-01T00:00:00Z' }]
    const result = await applyObservation(params(comments), d.value)
    expect(d.labelCalls()).toBe(1)
    expect(d.posted).toHaveLength(0)
    expect(result.labels).toEqual(APPLIED)
    expect(result.comment).toBeNull()
  })

  it('posts again for the same cause on a moved head', async () => {
    const d = deps()
    const comments = [{ body: '## Pipeline Escalation\nEarlier.\n<!-- port:escalation sha-cap old1111 -->', createdAt: '2026-01-01T00:00:00Z' }]
    await applyObservation(params(comments), d.value)
    expect(d.posted).toHaveLength(1)
  })
})

describe('applyObservation — plan-missing re-read', () => {
  const PLAN_MISSING_PARAMS: ApplyObservationParams = {
    ...params([]),
    item: { ...item([]), kind: 'issue', stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], planPresent: false },
    observation: { kind: 'plan-missing', number: 52, itemKind: 'issue' },
  }

  function preflightItem(body: string): GatePreflightFetch {
    return { ok: true, item: { kind: 'issue', number: 52, title: 'a ticket', url: 'https://github.com/acme/widgets/issues/52', state: 'OPEN', body, assignees: ['op'] }, viewer: 'op', fetchedAt: '2026-01-01T00:00:00Z' }
  }

  const FAILED: GatePreflightFetch = { ok: false, kind: 'timeout', message: 'timed out', fetchedAt: '2026-01-01T00:00:00Z' }
  const UNRESOLVED: GatePreflightFetch = { ok: true, item: null, viewer: 'op', fetchedAt: '2026-01-01T00:00:00Z' }

  it.each([
    { name: 'stale snapshot, plan on re-read', fetch: preflightItem('Why\n\n## Implementation Plan\n\nSteps'), labels: { kind: 'no-op' }, writes: 0, comments: 0 },
    { name: 'genuinely missing plan', fetch: preflightItem('Why\n\nNo plan here'), labels: APPLIED, writes: 1, comments: 1 },
    { name: 'heading only inside a longer line', fetch: preflightItem('See ## Implementation Plan below'), labels: APPLIED, writes: 1, comments: 1 },
    { name: 're-read fails', fetch: FAILED, labels: { kind: 'verify-failed', message: 'timed out' }, writes: 0, comments: 0 },
    { name: 're-read resolves to no item', fetch: UNRESOLVED, labels: { kind: 'item-unavailable' }, writes: 0, comments: 0 },
  ] as const)('$name', async ({ fetch, labels, writes, comments }) => {
    const d = deps()
    const requests: WriteStateParams[] = []
    const value = {
      ...d.value,
      writeState: (p: WriteStateParams) => {
        requests.push(p)
        return Promise.resolve(APPLIED)
      },
      fetchGatePreflight: () => Promise.resolve(fetch),
    }
    const result = await applyObservation(PLAN_MISSING_PARAMS, value)
    expect(result.labels).toEqual(labels)
    expect(requests).toHaveLength(writes)
    expect(d.posted).toHaveLength(comments)
    const request = requests[0]?.request
    if (request !== undefined) {
      expect(request.action).toBe('observe-plan-missing')
      expect(request.add).toEqual(['ready'])
      expect(request.remove).toEqual(['planReview'])
    }
  })
})

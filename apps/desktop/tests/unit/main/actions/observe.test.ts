import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'
import type { ApplyObservationParams, ReadyEntry } from '@/types/actions'
import { applyObservation } from '@/main/actions/observe'
import type { PostCommentParams } from '@/types/writes'

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
  }
}

function params(comments: ReconciledItem['comments']): ApplyObservationParams {
  return {
    entry: ENTRY,
    item: item(comments),
    observation: { kind: 'zero-diff', reason: 'zero-diff', number: 52, itemKind: 'pull-request', count: 2, headRefOid: 'abc1234' },
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
      applyLabels: () => {
        labels++
        return Promise.resolve(APPLIED)
      },
      postComment: (p) => {
        posted.push(p)
        return Promise.resolve(APPLIED)
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
    const comments = [{ body: '## Pipeline Escalation\nEarlier.\n<!-- port:escalation zero-diff abc1234 -->', createdAt: '2026-01-01T00:00:00Z' }]
    const result = await applyObservation(params(comments), d.value)
    expect(d.labelCalls()).toBe(1)
    expect(d.posted).toHaveLength(0)
    expect(result.labels).toEqual(APPLIED)
    expect(result.comment).toBeNull()
  })

  it('posts again for the same cause on a moved head', async () => {
    const d = deps()
    const comments = [{ body: '## Pipeline Escalation\nEarlier.\n<!-- port:escalation zero-diff old1111 -->', createdAt: '2026-01-01T00:00:00Z' }]
    await applyObservation(params(comments), d.value)
    expect(d.posted).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem, StageLabel } from '@/types/state'
import type { ItemsByNumberFetch } from '@/types/github'
import type { ItemDecisionRequest } from '@/types/actions'
import type { WriteOutcome, WriteStateParams } from '@/types/writes'
import { applyItemDecision } from '@/main/pipeline/operator/decide'
import { boardSnapshot as snapshotOf, readyEntry, reconciledItem, repositoryState } from '../../../fixtures/board-state'

const REPO_ID = 'repo-1' as unknown as RepoId
const FETCHED_AT = '2026-01-01T00:00:00.000Z'
const APPLIED: WriteOutcome = { kind: 'applied', argv: [] }

const REQUEST: ItemDecisionRequest = { repoId: REPO_ID, number: 300, decision: 'grant', expectedStage: 'needsRevision', route: null, note: null, skipComment: false, picks: null }

function stageLabel(key: StageLabel['key'], role: StageLabel['role']): StageLabel {
  return { key, name: key, role }
}

function cappedItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({
    repoId: REPO_ID,
    kind: 'pull-request',
    number: 300,
    stage: 'trigger',
    stages: [stageLabel('needsRevision', 'trigger')],
    status: 'waiting',
    matchedKeys: ['needsRevision'],
    headRefOid: 'a'.repeat(40),
    reviewCycleCount: 5,
    ...overrides,
  })
}

function fresh(labels: readonly string[]): ItemsByNumberFetch {
  return { ok: true, resolved: [{ number: 300, kind: 'pull-request', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels, assignees: ['op'], headRefName: null, author: null }], unavailable: [], fetchedAt: FETCHED_AT }
}

interface Calls {
  readonly bodies: string[]
  readonly writes: WriteStateParams[]
}

function run(options: { readonly item?: ReconciledItem; readonly fetch?: ItemsByNumberFetch; readonly comment?: WriteOutcome; readonly labels?: WriteOutcome; readonly liveStage?: boolean; readonly request?: ItemDecisionRequest }) {
  const calls: Calls = { bodies: [], writes: [] }
  const read = options.fetch ?? fresh(['needs revision'])
  const deps: Parameters<typeof applyItemDecision>[1] = {
    writeState: (params) => {
      calls.writes.push(params)
      return Promise.resolve(options.labels ?? { kind: 'no-op' })
    },
    stateLabels: () => (read.ok ? (read.resolved[0]?.labels ?? []) : []),
    postComment: (params) => {
      calls.bodies.push(params.request.body)
      return Promise.resolve(options.comment ?? APPLIED)
    },
    fetchItemsByNumber: () => Promise.resolve(read),
  }
  const snapshot = snapshotOf([repositoryState([options.item ?? cappedItem()], { repoId: REPO_ID, reviewCycleCap: 5 })])
  const result = applyItemDecision({ request: options.request ?? REQUEST, snapshot, entry: readyEntry({ id: REPO_ID }), auditDir: '/audit', scratchDir: '/scratch', liveStage: options.liveStage ?? false }, deps)
  return { result, calls }
}

describe('applyItemDecision — grant', () => {
  it('posts the cycle grant comment, then writes the unchanged label set and counts no-op as success', async () => {
    const { result, calls } = run({})
    expect(await result).toEqual({ ok: true, comment: APPLIED, labels: { kind: 'no-op' } })
    expect(calls.bodies).toEqual(['## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.'])
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0]?.request).toMatchObject({ add: ['needsRevision'], remove: [], action: 'grant' })
  })

  it('refuses moved when the fresh read carries needs human, posting nothing', async () => {
    const { result, calls } = run({ fetch: fresh(['needs revision', 'needs human']) })
    expect(await result).toMatchObject({ ok: false, reason: 'moved' })
    expect(calls.bodies).toEqual([])
    expect(calls.writes).toEqual([])
  })

  it('aborts comment-failed without touching the labels', async () => {
    const failed: WriteOutcome = { kind: 'write-failed', classification: 'unknown', stderr: 'boom', reread: null }
    const { result, calls } = run({ comment: failed })
    expect(await result).toEqual({ ok: false, reason: 'comment-failed', comment: failed })
    expect(calls.writes).toEqual([])
  })

  it('refuses agent-live while a stage session is live', async () => {
    const { result, calls } = run({ liveStage: true })
    expect(await result).toEqual({ ok: false, reason: 'refused', refusal: 'agent-live' })
    expect(calls.bodies).toEqual([])
  })

  it('refuses not-owned with the owners', async () => {
    const { result } = run({ item: cappedItem({ assignees: ['other'] }) })
    expect(await result).toEqual({ ok: false, reason: 'not-owned', owners: ['other'] })
  })

  it('throws below the cap, where grant does not apply', async () => {
    const { result } = run({ item: cappedItem({ reviewCycleCount: 2 }) })
    await expect(result).rejects.toThrow("'grant' is not applicable")
  })
})

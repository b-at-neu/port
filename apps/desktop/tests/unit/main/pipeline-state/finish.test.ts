import { describe, expect, it, vi } from 'vitest'
import { createPipelineFinish } from '@/main/pipeline-state/finish'
import type { ReadyEntry } from '@/types/actions'
import type { MirrorItemParams, PipelineStateStore, PipelineView, StoredItem } from '@/types/pipeline-state'
import type { WriteOutcome } from '@/types/writes'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo-a' as RepoId
const ENTRY = { id: REPO, path: '/repo', config: { repo: 'o/a' } } as unknown as ReadyEntry
const FAILURE = { at: 't', outcome: { kind: 'item-unavailable' as const } }

function stored(overrides: Partial<StoredItem> = {}): StoredItem {
  return { kind: 'issue', number: 7, keys: ['prOpened'], marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: 't', issue: null, mirrorFailure: null, ...overrides }
}

function rig(view: PipelineView) {
  const mirrored: MirrorItemParams[] = []
  const prune = vi.fn(() => Promise.resolve())
  const store = { view: () => view, prune } as unknown as PipelineStateStore
  const mirrorItem = vi.fn((params: MirrorItemParams): Promise<WriteOutcome> => {
    mirrored.push(params)
    return Promise.resolve({ kind: 'applied', argv: [] })
  })
  const finish = createPipelineFinish({ store, mirrorItem, auditDir: '/audit' })
  return { ...finish, mirrored, prune, mirrorItem }
}

describe('finishPipelineState', () => {
  const pr = stored({ kind: 'pull-request', number: 9, keys: ['approved'], issue: 7 })
  const ticket = stored()

  it('writes the terminal state on a merged pull request and on its ticket, then prunes', async () => {
    const r = rig({ kind: 'store', items: [ticket, pr] })
    await r.finishPipelineState(ENTRY, { closed: [7, 9], merged: [9] })
    expect(r.mirrored.map((call) => [call.ref, call.action, call.mode, call.auditDir])).toEqual([
      [{ kind: 'pull-request', number: 9 }, 'mirror-merged', 'merged', '/audit'],
      [{ kind: 'issue', number: 7 }, 'mirror-merged', 'merged', '/audit'],
    ])
    expect(r.prune).toHaveBeenCalledWith(REPO, [7, 9])
    expect(r.prune.mock.invocationCallOrder[0]).toBeGreaterThan(r.mirrorItem.mock.invocationCallOrder[1] ?? 0)
  })

  it('prunes a closed but unmerged item untouched', async () => {
    const r = rig({ kind: 'store', items: [ticket, pr] })
    await r.finishPipelineState(ENTRY, { closed: [7, 9], merged: [] })
    expect(r.mirrored).toEqual([])
    expect(r.prune).toHaveBeenCalledWith(REPO, [7, 9])
  })

  it('writes a merged pull request with no stored ticket on its own, and skips a merged number the store does not hold', async () => {
    const r = rig({ kind: 'store', items: [stored({ kind: 'pull-request', number: 9, issue: null })] })
    await r.finishPipelineState(ENTRY, { closed: [9, 12], merged: [9, 12] })
    expect(r.mirrored.map((call) => call.ref.number)).toEqual([9])
  })

  it('still prunes when a terminal write fails, never retrying it', async () => {
    const r = rig({ kind: 'store', items: [pr] })
    r.mirrorItem.mockResolvedValue({ kind: 'item-unavailable' })
    await r.finishPipelineState(ENTRY, { closed: [9], merged: [9] })
    expect(r.mirrorItem).toHaveBeenCalledTimes(1)
    expect(r.prune).toHaveBeenCalledWith(REPO, [9])
  })

  it('writes nothing under a labels view, and still prunes', async () => {
    const r = rig({ kind: 'labels' })
    await r.finishPipelineState(ENTRY, { closed: [9], merged: [9] })
    expect(r.mirrored).toEqual([])
    expect(r.prune).toHaveBeenCalledTimes(1)
  })
})

describe('retryMirrors', () => {
  it('re-mirrors only the items carrying a failure, as mirror-retry', async () => {
    const r = rig({ kind: 'store', items: [stored({ number: 1 }), stored({ number: 2, mirrorFailure: FAILURE }), stored({ kind: 'pull-request', number: 3, mirrorFailure: FAILURE })] })
    await r.retryMirrors(ENTRY)
    expect(r.mirrored.map((call) => [call.ref, call.action, call.mode])).toEqual([
      [{ kind: 'issue', number: 2 }, 'mirror-retry', 'state'],
      [{ kind: 'pull-request', number: 3 }, 'mirror-retry', 'state'],
    ])
  })

  it('retries at most ten items a poll', async () => {
    const items = Array.from({ length: 14 }, (_, index) => stored({ number: index + 1, mirrorFailure: FAILURE }))
    const r = rig({ kind: 'store', items })
    await r.retryMirrors(ENTRY)
    expect(r.mirrored).toHaveLength(10)
  })

  it('does nothing under a labels view', async () => {
    const r = rig({ kind: 'labels' })
    await r.retryMirrors(ENTRY)
    expect(r.mirrored).toEqual([])
  })
})

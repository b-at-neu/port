import { describe, expect, it, vi } from 'vitest'
import { createPipelineFinish } from '@/main/pipeline/state/finish'
import type { ReadyEntry } from '@/types/actions'
import type { MirrorItemParams, PipelineStateStore, StoreApplyResult } from '@/types/pipeline-state'
import type { WriteOutcome } from '@/types/writes'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { ticketOf } from '../../../support/tickets'

const REPO = 'repo-a' as RepoId
const ENTRY = { id: REPO, path: '/repo', config: { repo: 'o/a' } } as unknown as ReadyEntry
const FAILURE = { at: 't', outcome: { kind: 'item-unavailable' as const } }

const withPr = (ticket: number, pr: number, overrides: Partial<Ticket> = {}): Ticket => ticketOf({ ticket, pr: { number: pr, approvedAt: null }, stage: 'merge', status: { kind: 'waiting-on-you', gate: 'merge', detail: '' }, ...overrides })

function rig(tickets: readonly Ticket[] | null, now?: () => number) {
  const mirrored: MirrorItemParams[] = []
  const prune = vi.fn(() => Promise.resolve())
  const apply = vi.fn((): Promise<StoreApplyResult> => Promise.resolve({ ok: true, ticket: ticketOf(), changed: true }))
  const store = {
    tickets: () => tickets,
    ticket: (_id: RepoId, ref: { kind: string; number: number }) => tickets?.find((t) => (ref.kind === 'issue' ? t.ticket === ref.number : t.pr?.number === ref.number)) ?? null,
    apply,
    prune,
  } as unknown as PipelineStateStore
  const mirrorItem = vi.fn((params: MirrorItemParams): Promise<WriteOutcome> => {
    mirrored.push(params)
    return Promise.resolve({ kind: 'applied', argv: [] })
  })
  return { ...createPipelineFinish({ store, mirrorItem, auditDir: '/audit', ...(now === undefined ? {} : { now }) }), mirrored, prune, apply, mirrorItem }
}

describe('finishPipelineState', () => {
  it('marks a merged pull request done, mirrors its ticket, then prunes', async () => {
    const r = rig([withPr(7, 9)])
    await r.finishPipelineState(ENTRY, { closed: [7, 9], merged: [9] })
    expect(r.apply).toHaveBeenCalledWith(REPO, { kind: 'pull-request', number: 9 }, { kind: 'merged' }, null)
    expect(r.mirrored.map((call) => [call.ref, call.action, call.auditDir])).toEqual([[{ kind: 'pull-request', number: 9 }, 'mirror-merged', '/audit']])
    expect(r.prune).toHaveBeenCalledWith(REPO, [7, 9])
    expect(r.prune.mock.invocationCallOrder[0]).toBeGreaterThan(r.mirrorItem.mock.invocationCallOrder[0] ?? 0)
  })

  it('prunes a closed but unmerged item untouched', async () => {
    const r = rig([withPr(7, 9)])
    await r.finishPipelineState(ENTRY, { closed: [7, 9], merged: [] })
    expect(r.apply).not.toHaveBeenCalled()
    expect(r.mirrored).toEqual([])
    expect(r.prune).toHaveBeenCalledWith(REPO, [7, 9])
  })

  it('skips a merged number the store does not hold, and an unseeded repository, and still prunes', async () => {
    for (const tickets of [[withPr(7, 9)], null]) {
      const r = rig(tickets)
      await r.finishPipelineState(ENTRY, { closed: [12], merged: [12] })
      expect(r.mirrored).toEqual([])
      expect(r.prune).toHaveBeenCalledTimes(1)
    }
  })

  it('writes nothing when the table refuses the merge, and still prunes', async () => {
    const r = rig([withPr(7, 9)])
    r.apply.mockResolvedValue({ ok: false, reason: 'moved' })
    await r.finishPipelineState(ENTRY, { closed: [9], merged: [9] })
    expect(r.mirrored).toEqual([])
    expect(r.prune).toHaveBeenCalledWith(REPO, [9])
  })
})

describe('retryMirrors', () => {
  const failed = (ticket: number, pr: number | null): Ticket => ticketOf({ ticket, pr: pr === null ? null : { number: pr, approvedAt: null }, mirror: { written: [], failure: FAILURE } })

  it('re-mirrors only the tickets carrying a failure, as mirror-retry, through the pull request when there is one', async () => {
    const r = rig([ticketOf({ ticket: 1 }), failed(2, null), failed(3, 30)])
    await r.retryMirrors(ENTRY)
    expect(r.mirrored.map((call) => [call.ref, call.action])).toEqual([
      [{ kind: 'issue', number: 2 }, 'mirror-retry'],
      [{ kind: 'pull-request', number: 30 }, 'mirror-retry'],
    ])
  })

  it('retries at most ten tickets a poll', async () => {
    const r = rig(Array.from({ length: 14 }, (_, index) => failed(index + 1, null)))
    await r.retryMirrors(ENTRY)
    expect(r.mirrored).toHaveLength(10)
  })

  it('does nothing for an unseeded repository', async () => {
    const r = rig(null)
    await r.retryMirrors(ENTRY)
    expect(r.mirrored).toEqual([])
  })

  it('retries a persisting failure only once per backoff window', async () => {
    let clock = 1_000
    const r = rig([failed(2, null)], () => clock)
    await r.retryMirrors(ENTRY)
    clock += 60_000
    await r.retryMirrors(ENTRY)
    expect(r.mirrored).toHaveLength(1)
    clock += 5 * 60_000
    await r.retryMirrors(ENTRY)
    expect(r.mirrored).toHaveLength(2)
  })
})

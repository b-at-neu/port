import { describe, expect, it, vi } from 'vitest'
import { HANDOFF_ATTEMPTS, createStageHandoff } from '@/main/dispatch/handoff'
import type { ReadyEntry } from '@/types/actions'
import type { SessionKey } from '@/types/hosting'
import type { StageTransitionResult } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo-a' as RepoId
const OTHER_REPO = 'repo-b' as RepoId
const KEY = 'hosted-1' as SessionKey
const RECORD = { sessionKey: KEY, number: 52, kind: 'issue', agent: 'impl', trigger: 'planApproved' } as const
const ENTRY = { id: REPO } as unknown as ReadyEntry

function outcome(kind: StageOutcome['kind'], handback: StageOutcome['handback'] = null): StageOutcome {
  return { kind, detail: null, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback }
}

const APPLIED: StageTransitionResult = { kind: 'applied' }
const TRANSIENT: StageTransitionResult = { kind: 'refused', reason: 'write-failed', retryable: true, detail: 'boom' }

function rig(results: readonly StageTransitionResult[] = [APPLIED]) {
  const queue = [...results]
  const write = vi.fn(() => Promise.resolve(queue.shift() ?? APPLIED))
  const requestRead = vi.fn()
  const onChange = vi.fn()
  const handoff = createStageHandoff({ write, auditDir: '/audit', onChange, requestRead })
  handoff.remember(ENTRY)
  return { handoff, write, requestRead, onChange }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createStageHandoff', () => {
  it('writes a completed hand-back once, reports applied, and asks for one read', async () => {
    const { handoff, write, requestRead, onChange } = rig()
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ entry: ENTRY, record: RECORD, event: { kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' } }, auditDir: '/audit' })
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    expect(requestRead).toHaveBeenCalledTimes(1)
    expect(requestRead).toHaveBeenCalledWith(REPO)
    expect(onChange).toHaveBeenCalled()
  })

  it('retries a transient failure on later passes, up to three attempts in all, then reports a refusal', async () => {
    const { handoff, write, requestRead } = rig([TRANSIENT, TRANSIENT, TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    expect(handoff.resultFor(KEY)).toBeNull()

    await handoff.retryPending(REPO)
    expect(handoff.resultFor(KEY)).toBeNull()
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'write-failed', detail: 'boom' })
    expect(requestRead).toHaveBeenCalledTimes(1)

    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS)
  })

  it('a transient failure followed by success reports applied', async () => {
    const { handoff, write } = rig([TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(2)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('never retries a moved refusal', async () => {
    const { handoff, write } = rig([{ kind: 'refused', reason: 'moved', retryable: false, detail: null }])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(1)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'moved', detail: null })
  })

  it('a throw counts as a retryable write failure', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('exploded')).mockResolvedValue(APPLIED)
    const handoff = createStageHandoff({ write, auditDir: '/audit', onChange: vi.fn(), requestRead: vi.fn() })
    handoff.remember(ENTRY)
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    expect(handoff.resultFor(KEY)).toBeNull()
    await handoff.retryPending(REPO)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it.each(['questions', 'interrupted', 'usage-limit'] as const)('a %s outcome writes nothing and has no result', async (kind) => {
    const { handoff, write } = rig()
    handoff.settle(REPO, RECORD, outcome(kind))
    await flush()
    expect(write).not.toHaveBeenCalled()
    expect(handoff.resultFor(KEY)).toBeNull()
  })

  it('blocked writes for impl only', async () => {
    const { handoff, write } = rig()
    handoff.settle(REPO, RECORD, outcome('blocked'))
    handoff.settle(REPO, { ...RECORD, sessionKey: 'hosted-2' as SessionKey, agent: 'review', kind: 'pull-request', trigger: 'readyForReview' }, outcome('blocked'))
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('an error outcome is an ordinary write, with no read requested', async () => {
    const { handoff, write, requestRead } = rig()
    handoff.settle(REPO, RECORD, outcome('error'))
    await flush()
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: 'outcome', outcome: 'error', handback: null } }))
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    expect(requestRead).not.toHaveBeenCalled()
  })

  it('a completed outcome with no hand-back line is passed through to be refused, and reported', async () => {
    const { handoff } = rig([{ kind: 'refused', reason: 'no-handback', retryable: false, detail: null }])
    handoff.settle(REPO, RECORD, outcome('completed'))
    await flush()
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'no-handback', detail: null })
  })

  it('a later outcome for the same session clears the earlier result while it is pending', async () => {
    const { handoff } = rig([APPLIED, TRANSIENT])
    handoff.settle(REPO, RECORD, outcome('blocked'))
    await flush()
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    expect(handoff.resultFor(KEY)).toBeNull()
  })

  it('the next turn after a block writes under its own pending key, with no result and no read', async () => {
    const { handoff, write, requestRead } = rig()
    handoff.resumedTurn(REPO, RECORD)
    await flush()
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: 'resumed-turn' } }))
    expect(handoff.resultFor(KEY)).toBeNull()
    expect(requestRead).not.toHaveBeenCalled()
  })

  it('serializes one repository’s writes', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const write = vi.fn((params: { readonly record: { readonly number: number } }) => {
      order.push(`start ${String(params.record.number)}`)
      if (params.record.number === 52) {
        return new Promise<StageTransitionResult>((resolve) => {
          release = () => {
            order.push('end 52')
            resolve(APPLIED)
          }
        })
      }
      order.push(`end ${String(params.record.number)}`)
      return Promise.resolve(APPLIED)
    })
    const handoff = createStageHandoff({ write, auditDir: '/audit', onChange: vi.fn(), requestRead: vi.fn() })
    handoff.remember(ENTRY)
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    handoff.settle(REPO, { ...RECORD, sessionKey: 'hosted-2' as SessionKey, number: 53 }, outcome('completed', { token: 'pr-opened', arg: '#9' }))
    await flush()
    expect(order).toEqual(['start 52'])
    release()
    await flush()
    expect(order).toEqual(['start 52', 'end 52', 'start 53', 'end 53'])
  })

  it('retryPending touches only its own repository', async () => {
    const { handoff, write } = rig([TRANSIENT])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    await handoff.retryPending(OTHER_REPO)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not write for a repository it has not seen, and keeps the write pending', async () => {
    const write = vi.fn(() => Promise.resolve(APPLIED))
    const handoff = createStageHandoff({ write, auditDir: '/audit', onChange: vi.fn(), requestRead: vi.fn() })
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await flush()
    expect(write).not.toHaveBeenCalled()
    handoff.remember(ENTRY)
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(1)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('does not write a finished hand-back a second time when a retry races its first attempt', async () => {
    const { handoff, write } = rig()
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }))
    await handoff.retryPending(REPO)
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
  })
})

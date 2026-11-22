import { describe, expect, it, vi } from 'vitest'
import { HANDOFF_ATTEMPTS, HANDOFF_RETRY_WINDOW_MS, createStageHandoff } from '@/main/dispatch/handoff'
import type { ReadyEntry } from '@/types/actions'
import type { SessionKey } from '@/types/hosting'
import type { StageTransitionResult } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo-a' as RepoId
const OTHER_REPO = 'repo-b' as RepoId
const KEY = 'hosted-1' as SessionKey
const RECORD = { sessionKey: KEY, number: 52, kind: 'issue', agent: 'impl', trigger: 'planApproved' } as const
const ENTRY = { id: REPO, config: { repo: 'o/a' } } as unknown as ReadyEntry

function outcome(kind: StageOutcome['kind'], handback: StageOutcome['handback'] = null): StageOutcome {
  return { kind, detail: null, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback }
}

const APPLIED: StageTransitionResult = { kind: 'applied' }
const TRANSIENT: StageTransitionResult = { kind: 'refused', reason: 'write-failed', retryable: true, detail: 'boom' }

const clock = { ms: Date.parse('2026-01-01T00:00:00.000Z') }
const now = (): Date => new Date(clock.ms)

function rig(results: readonly StageTransitionResult[] = [APPLIED]) {
  clock.ms = Date.parse('2026-01-01T00:00:00.000Z')
  const queue = [...results]
  const write = vi.fn(() => Promise.resolve(queue.shift() ?? APPLIED))
  const requestRead = vi.fn()
  const onChange = vi.fn()
  const recordIncident = vi.fn(() => Promise.resolve())
  const handoff = createStageHandoff({ write, auditDir: '/audit', scratchDir: '/scratch', onChange, recordIncident, requestRead, now })
  handoff.remember(ENTRY)
  return { handoff, write, requestRead, onChange, recordIncident }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createStageHandoff', () => {
  it('writes a completed hand-back once, reports applied, and asks for one read', async () => {
    const { handoff, write, requestRead, onChange } = rig()
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ entry: ENTRY, record: RECORD, event: { kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null }, auditDir: '/audit', scratchDir: '/scratch' })
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    expect(requestRead).toHaveBeenCalledTimes(1)
    expect(requestRead).toHaveBeenCalledWith(REPO)
    expect(onChange).toHaveBeenCalled()
  })

  it('retries a transient failure on later passes, up to three attempts in all once the retry window has passed, then reports a refusal', async () => {
    const { handoff, write, requestRead, recordIncident } = rig([TRANSIENT, TRANSIENT, TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    expect(handoff.resultFor(KEY)).toBeNull()
    expect(recordIncident).not.toHaveBeenCalled()

    await handoff.retryPending(REPO)
    expect(handoff.resultFor(KEY)).toBeNull()
    clock.ms += HANDOFF_RETRY_WINDOW_MS + 1
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'write-failed', detail: 'boom' })
    expect(recordIncident).toHaveBeenCalledTimes(1)
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'refused-write', stage: 'impl', condition: 'handoff-write-failed', repo: 'o/a', number: 52, inputs: { sessionKey: KEY, attempts: HANDOFF_ATTEMPTS, retryable: true, trigger: 'planApproved' } }))
    expect(requestRead).toHaveBeenCalledTimes(1)

    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS)
  })

  it('keeps retrying a transient failure past three attempts while the retry window is open, so a write that fails while DNS returns after a wake still lands', async () => {
    const { handoff, write } = rig([TRANSIENT, TRANSIENT, TRANSIENT, TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    for (let pass = 0; pass < 4; pass++) await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(5)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('reports the ticket as pending until its write settles', async () => {
    const { handoff } = rig([TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    expect([...handoff.pendingNumbers(REPO)]).toEqual([52])
    expect([...handoff.pendingNumbers(OTHER_REPO)]).toEqual([])
    await handoff.retryPending(REPO)
    expect([...handoff.pendingNumbers(REPO)]).toEqual([])
  })

  it('a transient failure followed by success reports applied', async () => {
    const { handoff, write } = rig([TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(2)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('never retries a moved refusal', async () => {
    const { handoff, write } = rig([{ kind: 'refused', reason: 'moved', retryable: false, detail: null }])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(1)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'moved', detail: null })
  })

  it('the captured plan rides the event across every retry', async () => {
    const plan = { kind: 'read', body: '## Implementation Plan' } as const
    const { handoff, write } = rig([TRANSIENT, APPLIED])
    handoff.settle(REPO, { ...RECORD, agent: 'plan', trigger: 'ready' }, outcome('completed', { token: 'plan-written', arg: null }), plan)
    await flush()
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(2)
    for (const call of write.mock.calls as unknown as readonly [{ readonly event: { readonly plan: unknown } }][]) expect(call[0].event.plan).toBe(plan)
  })

  it('a throw counts as a retryable write failure', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('exploded')).mockResolvedValue(APPLIED)
    const handoff = createStageHandoff({ write, auditDir: '/audit', scratchDir: '/scratch', onChange: vi.fn(), recordIncident: vi.fn(() => Promise.resolve()), requestRead: vi.fn(), now })
    handoff.remember(ENTRY)
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    expect(handoff.resultFor(KEY)).toBeNull()
    await handoff.retryPending(REPO)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it.each(['questions', 'interrupted', 'usage-limit'] as const)('a %s outcome writes nothing and has no result', async (kind) => {
    const { handoff, write } = rig()
    handoff.settle(REPO, RECORD, outcome(kind), null)
    await flush()
    expect(write).not.toHaveBeenCalled()
    expect(handoff.resultFor(KEY)).toBeNull()
  })

  it('blocked writes for impl only', async () => {
    const { handoff, write } = rig()
    handoff.settle(REPO, RECORD, outcome('blocked'), null)
    handoff.settle(REPO, { ...RECORD, sessionKey: 'hosted-2' as SessionKey, agent: 'review', kind: 'pull-request', trigger: 'readyForReview' }, outcome('blocked'), null)
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('an error outcome is an ordinary write, with no read requested', async () => {
    const { handoff, write, requestRead } = rig()
    handoff.settle(REPO, RECORD, outcome('error'), null)
    await flush()
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: 'outcome', outcome: 'error', handback: null, plan: null } }))
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    expect(requestRead).not.toHaveBeenCalled()
  })

  it('a completed outcome with no hand-back line is passed through to be refused, and reported', async () => {
    const { handoff } = rig([{ kind: 'refused', reason: 'no-handback', retryable: false, detail: null }])
    handoff.settle(REPO, RECORD, outcome('completed'), null)
    await flush()
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'no-handback', detail: null })
  })

  it('a later outcome for the same session clears the earlier result while it is pending', async () => {
    const { handoff } = rig([APPLIED, TRANSIENT])
    handoff.settle(REPO, RECORD, outcome('blocked'), null)
    await flush()
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
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
    const handoff = createStageHandoff({ write, auditDir: '/audit', scratchDir: '/scratch', onChange: vi.fn(), recordIncident: vi.fn(() => Promise.resolve()), requestRead: vi.fn(), now })
    handoff.remember(ENTRY)
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    handoff.settle(REPO, { ...RECORD, sessionKey: 'hosted-2' as SessionKey, number: 53 }, outcome('completed', { token: 'pr-opened', arg: '#9' }), null)
    await flush()
    expect(order).toEqual(['start 52'])
    release()
    await flush()
    expect(order).toEqual(['start 52', 'end 52', 'start 53', 'end 53'])
  })

  it('retryPending touches only its own repository', async () => {
    const { handoff, write } = rig([TRANSIENT])
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    await handoff.retryPending(OTHER_REPO)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not write for a repository it has not seen, and keeps the write pending', async () => {
    const write = vi.fn(() => Promise.resolve(APPLIED))
    const handoff = createStageHandoff({ write, auditDir: '/audit', scratchDir: '/scratch', onChange: vi.fn(), recordIncident: vi.fn(() => Promise.resolve()), requestRead: vi.fn(), now })
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await flush()
    expect(write).not.toHaveBeenCalled()
    handoff.remember(ENTRY)
    await handoff.retryPending(REPO)
    expect(write).toHaveBeenCalledTimes(1)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('does not write a finished hand-back a second time when a retry races its first attempt', async () => {
    const { handoff, write } = rig()
    handoff.settle(REPO, RECORD, outcome('completed', { token: 'pr-opened', arg: '#8' }), null)
    await handoff.retryPending(REPO)
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
  })
})

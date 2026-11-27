import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_ATTEMPTS, HANDOFF_RETRY_WINDOW_MS, createStageHandoff } from '@/main/dispatch/handoff'
import type { StageSnapshot } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { StageTransitionResult } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'
import { dispatchContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'

const apply = vi.hoisted(() => vi.fn<(params: unknown) => Promise<StageTransitionResult>>())
vi.mock('@/main/pipeline/operator/stage', () => ({ applyStageTransition: (_ctx: unknown, params: unknown) => apply(params) }))

const REPO = 'repo-a' as RepoId
const OTHER_REPO = 'repo-b' as RepoId
const KEY = 'hosted-1' as SessionKey
const RECORD = { sessionKey: KEY, number: 52, kind: 'issue', agent: 'impl', stage: 'implement' } as const
const ENTRY = readyEntry()
const SNAPSHOT = {} as unknown as StageSnapshot

function outcome(kind: StageOutcome['kind'], handback: StageOutcome['handback'] = null): StageOutcome {
  return { kind, detail: null, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback }
}

const APPLIED: StageTransitionResult = { kind: 'applied' }
const TRANSIENT: StageTransitionResult = { kind: 'refused', reason: 'write-failed', retryable: true, detail: 'boom' }
const PR_OPENED = { token: 'pr-opened', arg: '#8' } as const

async function rig(results: readonly StageTransitionResult[] = [APPLIED], { remember = true }: { remember?: boolean } = {}) {
  const queue = [...results]
  apply.mockReset().mockImplementation(() => Promise.resolve(queue.shift() ?? APPLIED))
  const ctx = await dispatchContext()
  const recordIncident = vi.spyOn(ctx.stores.incidentLog, 'record').mockResolvedValue(undefined)
  const handoff = createStageHandoff(ctx, () => SNAPSHOT)
  if (remember) handoff.remember(ENTRY)
  return { ctx, handoff, recordIncident }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  apply.mockReset()
})

describe('createStageHandoff', () => {
  it('writes a completed hand-back once, reports applied, and asks for one read', async () => {
    const { ctx, handoff } = await rig()
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ entry: ENTRY, record: RECORD, event: { kind: 'outcome', outcome: 'completed', handback: PR_OPENED, plan: null }, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp, snapshot: SNAPSHOT })
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    expect(ctx.watcher.refresh).toHaveBeenCalledTimes(1)
    expect(ctx.watcher.refresh).toHaveBeenCalledWith({ repoId: REPO, source: 'github' })
    expect(ctx.watcher.republish).toHaveBeenCalled()
  })

  it('retries a transient failure on later passes, up to three attempts in all once the retry window has passed, then reports a refusal', async () => {
    const { ctx, handoff, recordIncident } = await rig([TRANSIENT, TRANSIENT, TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    expect(handoff.resultFor(KEY)).toBeNull()
    expect(recordIncident).not.toHaveBeenCalled()

    await handoff.retryPending(REPO)
    expect(handoff.resultFor(KEY)).toBeNull()
    ctx.clock.advance(HANDOFF_RETRY_WINDOW_MS + 1)
    await handoff.retryPending(REPO)
    expect(apply).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'write-failed', detail: 'boom' })
    expect(recordIncident).toHaveBeenCalledTimes(1)
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'refused-write', stage: 'impl', condition: 'handoff-write-failed', repo: 'o/a', number: 52, inputs: { sessionKey: KEY, attempts: HANDOFF_ATTEMPTS, retryable: true, stage: 'implement' } }))
    expect(ctx.watcher.refresh).toHaveBeenCalledTimes(1)

    await handoff.retryPending(REPO)
    expect(apply).toHaveBeenCalledTimes(HANDOFF_ATTEMPTS)
  })

  it('keeps retrying a transient failure past three attempts while the retry window is open, so a write that fails while DNS returns after a wake still lands', async () => {
    const { handoff } = await rig([TRANSIENT, TRANSIENT, TRANSIENT, TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    for (let pass = 0; pass < 4; pass++) await handoff.retryPending(REPO)
    expect(apply).toHaveBeenCalledTimes(5)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('reports the ticket as pending until its write settles', async () => {
    const { handoff } = await rig([TRANSIENT, APPLIED])
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    expect([...handoff.pendingNumbers(REPO)]).toEqual([52])
    expect([...handoff.pendingNumbers(OTHER_REPO)]).toEqual([])
    await handoff.retryPending(REPO)
    expect([...handoff.pendingNumbers(REPO)]).toEqual([])
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('never retries a moved refusal', async () => {
    const { handoff } = await rig([{ kind: 'refused', reason: 'moved', retryable: false, detail: null }])
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    await handoff.retryPending(REPO)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'moved', detail: null })
  })

  it('the captured plan rides the event across every retry', async () => {
    const plan = { kind: 'read', body: '## Implementation Plan' } as const
    const { handoff } = await rig([TRANSIENT, APPLIED])
    handoff.settle(REPO, { ...RECORD, agent: 'plan', stage: 'plan' }, outcome('completed', { token: 'plan-written', arg: null }), plan)
    await flush()
    await handoff.retryPending(REPO)
    expect(apply).toHaveBeenCalledTimes(2)
    for (const call of apply.mock.calls as unknown as readonly [{ readonly event: { readonly plan: unknown } }][]) expect(call[0].event.plan).toBe(plan)
  })

  it('a throw counts as a retryable write failure', async () => {
    const { handoff } = await rig()
    apply.mockReset().mockRejectedValueOnce(new Error('exploded')).mockResolvedValue(APPLIED)
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    expect(handoff.resultFor(KEY)).toBeNull()
    await handoff.retryPending(REPO)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it.each(['questions', 'interrupted', 'usage-limit'] as const)('a %s outcome writes nothing and has no result', async (kind) => {
    const { handoff } = await rig()
    handoff.settle(REPO, RECORD, outcome(kind), null)
    await flush()
    expect(apply).not.toHaveBeenCalled()
    expect(handoff.resultFor(KEY)).toBeNull()
  })

  it('blocked writes for impl only', async () => {
    const { handoff } = await rig()
    handoff.settle(REPO, RECORD, outcome('blocked'), null)
    handoff.settle(REPO, { ...RECORD, sessionKey: 'hosted-2' as SessionKey, agent: 'review', kind: 'pull-request', stage: 'review' }, outcome('blocked'), null)
    await flush()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('an error outcome is an ordinary write, with no read requested', async () => {
    const { ctx, handoff } = await rig()
    handoff.settle(REPO, RECORD, outcome('error'), null)
    await flush()
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: 'outcome', outcome: 'error', handback: null, plan: null } }))
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })

  it('a completed outcome with no hand-back line is passed through to be refused, and reported', async () => {
    const { handoff } = await rig([{ kind: 'refused', reason: 'no-handback', retryable: false, detail: null }])
    handoff.settle(REPO, RECORD, outcome('completed'), null)
    await flush()
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'refused', reason: 'no-handback', detail: null })
  })

  it('a later outcome for the same session clears the earlier result while it is pending', async () => {
    const { handoff } = await rig([APPLIED, TRANSIENT])
    handoff.settle(REPO, RECORD, outcome('blocked'), null)
    await flush()
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    expect(handoff.resultFor(KEY)).toBeNull()
  })

  it('the next turn after a block writes under its own pending key, with no result and no read', async () => {
    const { ctx, handoff } = await rig()
    handoff.resumedTurn(REPO, RECORD)
    await flush()
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: 'resumed-turn' } }))
    expect(handoff.resultFor(KEY)).toBeNull()
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })

  it('serializes one repository’s writes', async () => {
    const { handoff } = await rig()
    let release: () => void = () => undefined
    let running = 0
    let overlapped = false
    const started = new Set<number>()
    apply.mockReset().mockImplementation((params) => {
      const { number } = (params as { readonly record: { readonly number: number } }).record
      started.add(number)
      if (running > 0) overlapped = true
      if (number === 52) {
        running += 1
        return new Promise<StageTransitionResult>((resolve) => {
          release = () => {
            running -= 1
            resolve(APPLIED)
          }
        })
      }
      return Promise.resolve(APPLIED)
    })
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    handoff.settle(REPO, { ...RECORD, sessionKey: 'hosted-2' as SessionKey, number: 53 }, outcome('completed', { token: 'pr-opened', arg: '#9' }), null)
    await flush()
    expect([...started]).toEqual([52])
    release()
    await flush()
    expect([...started].sort()).toEqual([52, 53])
    expect(overlapped).toBe(false)
  })

  it('retryPending touches only its own repository', async () => {
    const { handoff } = await rig([TRANSIENT])
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    await handoff.retryPending(OTHER_REPO)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does not write for a repository it has not seen, and keeps the write pending', async () => {
    const { handoff } = await rig([APPLIED], { remember: false })
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await flush()
    expect(apply).not.toHaveBeenCalled()
    handoff.remember(ENTRY)
    await handoff.retryPending(REPO)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(handoff.resultFor(KEY)).toEqual({ kind: 'applied' })
  })

  it('does not write a finished hand-back a second time when a retry races its first attempt', async () => {
    const { handoff } = await rig()
    handoff.settle(REPO, RECORD, outcome('completed', PR_OPENED), null)
    await handoff.retryPending(REPO)
    await flush()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

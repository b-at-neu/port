// The operator's run controls over a repository with a stage in flight: pause stops it, drain lets it finish, neither starts anything new.
import { describe, expect, it } from 'vitest'
import type { SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import { callAction } from '../support/context'
import { actionable, diskWith, SCENARIO_REPO, scenarioRig, tickReport } from '../support/scenario'
import { ticketOf } from '../support/tickets'

const AT = '2026-01-01T00:00:00.000Z'
const ITEMS = [
  { number: 52, title: 'first', labels: ['port', 'planApproved'], assignees: ['op'] },
  { number: 53, title: 'second', labels: ['port', 'planApproved'], assignees: ['op'] },
]
const queued = (ticket: number) => ticketOf({ repo: SCENARIO_REPO, ticket, stage: 'implement', status: { kind: 'queued', reason: 'new', since: AT } })
const COMPLETED: StageOutcome = { kind: 'completed', detail: null, costUsd: 1, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: { token: 'pr-opened', arg: '#8' } }

describe('pause and drain', () => {
  it('pause stops the claimed ticket, stands the dispatcher down, and launches nothing afterwards', async () => {
    const app = await scenarioRig({ fs: await diskWith(queued(52), queued(53)), items: ITEMS })
    await app.consider(tickReport({ actionable: [actionable(52, 'planApproved', 'impl')] }))
    expect(app.stage.launches).toHaveLength(1)
    app.showBoard(app.claimedItem(52))

    const result = await callAction(app.ctx, 'dispatch.control', { command: 'pause', repoId: SCENARIO_REPO })

    expect(result).toMatchObject({ ok: true, runState: { state: 'paused' }, report: { kind: 'completed', items: [{ kind: 'stopped', number: 52 }] } })
    expect(await app.ticket(52)).toMatchObject({ stage: 'implement', status: { kind: 'held' } })

    await app.consider(tickReport({ actionable: [actionable(53, 'planApproved', 'impl')] }))
    expect(app.stage.launches).toHaveLength(1)
    expect(await app.ticket(53)).toMatchObject({ status: { kind: 'queued' } })
  })

  it('drain lets the running stage hand back, and launches nothing new', async () => {
    const app = await scenarioRig({ fs: await diskWith(queued(52), queued(53)), items: [...ITEMS, { number: 8, kind: 'pull-request', title: 'first', headRefName: '52-first', assignees: ['op'] }] })
    await app.consider(tickReport({ actionable: [actionable(52, 'planApproved', 'impl')] }))

    const result = await callAction(app.ctx, 'dispatch.control', { command: 'drain', repoId: SCENARIO_REPO })
    expect(result).toMatchObject({ ok: true, runState: { state: 'draining' } })

    await app.consider(tickReport({ actionable: [actionable(53, 'planApproved', 'impl')] }))
    expect(app.stage.launches).toHaveLength(1)

    await app.finish('hosted-1' as SessionKey, COMPLETED)
    await app.consider(tickReport())
    expect(await app.ticket(52)).toMatchObject({ stage: 'review', status: { kind: 'queued' } })
    expect(await app.ticket(53)).toMatchObject({ stage: 'implement', status: { kind: 'queued' } })
  })
})

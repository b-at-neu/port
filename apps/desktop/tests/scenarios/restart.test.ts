// An app restart and a system sleep during an active run, ending with no finished work re-dispatched.
import { describe, expect, it, vi } from 'vitest'
import type { SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import { actionable, diskWith, SCENARIO_REPO, scenarioRig, tickReport } from '../support/scenario'
import { ticketOf } from '../support/tickets'

const IMPL = [actionable(52, 'planApproved', 'impl')]
const COMPLETED: StageOutcome = { kind: 'completed', detail: null, costUsd: 1, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: { token: 'pr-opened', arg: '#8' } }
const ITEMS = [
  { number: 52, title: 't', labels: ['plan approved'], assignees: ['op'] },
  { number: 8, kind: 'pull-request' as const, title: 't', headRefName: '52-t', assignees: ['op'] },
]

const queued = ticketOf({ repo: SCENARIO_REPO, ticket: 52, stage: 'implement', status: { kind: 'queued', reason: 'new', since: '2026-01-01T00:00:00.000Z' } })

const settled = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('restart and sleep during an active run', () => {
  it('a restart mid-run reads the run as a crash, keeps its claim interrupted, and launches nothing', async () => {
    const fs = await diskWith(queued)
    const before = await scenarioRig({ fs, items: ITEMS })
    await before.consider(tickReport({ actionable: IMPL }))
    expect(before.stage.launches).toHaveLength(1)

    const after = await scenarioRig({ fs, items: ITEMS })
    expect(after.runs.list()).toMatchObject([{ id: 'run-1', reason: 'crash', number: 52 }])
    await after.consider(tickReport())
    const tick = after.tickOver(after.claimedItem(52), '2026-01-01T01:00:00.000Z')
    expect(tick.claims).toMatchObject([{ number: 52, class: 'interrupted' }])
    await after.consider(tick)
    expect(after.stage.launches).toHaveLength(0)
    expect(await after.ticket(52)).toMatchObject({ stage: 'implement', status: { kind: 'running' } })
  })

  it('a restart after a hand-back that never reached its label settles it once, and launches nothing', async () => {
    const fs = await diskWith(queued)
    const before = await scenarioRig({ fs, items: ITEMS })
    await before.consider(tickReport({ actionable: IMPL }))
    await before.stage.handBack('hosted-1' as SessionKey, COMPLETED)

    const after = await scenarioRig({ fs, items: ITEMS })
    await after.consider(tickReport())
    await vi.waitFor(async () => expect(await after.ticket(52)).toMatchObject({ stage: 'review', status: { kind: 'queued' } }))
    const settledTicket = await after.ticket(52)

    await after.consider(tickReport())
    await settled()
    expect(await after.ticket(52)).toEqual(settledTicket)
    expect(after.stage.launches).toHaveLength(0)
    const tick = after.tickOver(after.claimedItem(52), '2026-01-01T01:00:00.000Z')
    expect(tick.claims).toMatchObject([{ number: 52, class: 'capped' }])
    expect(tick.observations.filter((o) => o.kind === 'liveness-reset')).toEqual([])
  })

  it('a sleep with the session live keeps the claim matched, and the hand-back after the wake lands once', async () => {
    const fs = await diskWith(queued)
    const app = await scenarioRig({ fs, items: ITEMS })
    await app.consider(tickReport({ actionable: IMPL }))
    expect(app.stage.launches).toHaveLength(1)

    app.ctx.clock.advance(9 * 60 * 60 * 1000)
    await app.consider(tickReport())
    expect(app.dispatcher.stageLiveness(SCENARIO_REPO)?.live).toEqual(['impl #52'])
    expect(app.tickOver(app.claimedItem(52), app.ctx.clock.now().toISOString()).claims).toMatchObject([{ number: 52, class: 'matched' }])

    await app.stage.handBack('hosted-1' as SessionKey, COMPLETED)
    app.dispatcher.recordOutcome(SCENARIO_REPO, 'hosted-1' as SessionKey, COMPLETED, null)
    await vi.waitFor(async () => expect(await app.ticket(52)).toMatchObject({ stage: 'review', status: { kind: 'queued' } }))
    const landed = await app.ticket(52)
    await app.consider(tickReport())
    await settled()
    expect(await app.ticket(52)).toEqual(landed)
    expect(app.github.labels(52)).toEqual(['port', 'reviewing'])
    expect(app.stage.launches).toHaveLength(1)
  })
})

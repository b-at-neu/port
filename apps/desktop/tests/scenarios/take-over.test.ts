// Who runs the pipeline: nothing launches until the app owns the repository, and it never takes one another session holds.
import { describe, expect, it } from 'vitest'
import { callAction } from '../support/context'
import { actionable, diskWith, SCENARIO_REPO, scenarioRig, tickReport } from '../support/scenario'
import { ticketOf } from '../support/tickets'

const AT = '2026-01-01T00:00:00.000Z'
const ITEMS = [{ number: 52, title: 'first', labels: ['port', 'planApproved'], assignees: ['op'] }]
const queued = ticketOf({ repo: SCENARIO_REPO, ticket: 52, stage: 'implement', status: { kind: 'queued', reason: 'new', since: AT } })
const WORK = tickReport({ actionable: [actionable(52, 'planApproved', 'impl')] })

describe('taking over a repository', () => {
  it('a paused, unowned repository launches nothing until the operator runs it, then launches once', async () => {
    const app = await scenarioRig({ fs: await diskWith(queued), items: ITEMS, owner: 'none', runState: 'paused' })
    await app.consider(WORK)
    expect(app.stage.launches).toHaveLength(0)

    const result = await callAction(app.ctx, 'dispatch.control', { command: 'run', repoId: SCENARIO_REPO })
    expect(result).toMatchObject({ ok: true, runState: { state: 'dispatching' } })
    expect(await app.ownerOnDisk()).toBe('app')

    await app.consider(WORK)
    expect(app.stage.launches).toHaveLength(1)
    expect(app.ticket(52)).toMatchObject({ stage: 'implement', status: { kind: 'running' } })
  })

  it('a repository another session owns refuses the run, keeps that owner, and launches nothing', async () => {
    const app = await scenarioRig({ fs: await diskWith(queued), items: ITEMS, owner: 'terminal', runState: 'paused' })

    const result = await callAction(app.ctx, 'dispatch.control', { command: 'run', repoId: SCENARIO_REPO })
    expect(result).toMatchObject({ ok: false, command: 'run', reason: 'ownership-unreadable' })
    expect(await app.ownerOnDisk()).toBe('terminal')

    await app.consider(WORK)
    expect(app.stage.launches).toHaveLength(0)
    expect(app.ticket(52)).toMatchObject({ status: { kind: 'queued' } })
  })

  it('a restart that finds the record gone while dispatching takes the repository back', async () => {
    const app = await scenarioRig({ fs: await diskWith(queued), items: ITEMS, owner: 'none', runState: 'dispatching' })
    await app.consider(WORK)

    expect(await app.ownerOnDisk()).toBe('app')
    expect(app.stage.launches).toHaveLength(1)
  })
})

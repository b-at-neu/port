// A ticket through its stages: each one launches once, and its hand-back moves the record and the mirror labels.
import { describe, expect, it, vi } from 'vitest'
import type { SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import { actionable, diskWith, SCENARIO_REPO, scenarioRig, tickReport } from '../support/scenario'
import { ticketOf } from '../support/tickets'

const AT = '2026-01-01T00:00:00.000Z'
const PLAN = '## Plan\n\n- [ ] do the thing\n'
const handback = (token: string, arg: string | null): StageOutcome => ({ kind: 'completed', detail: null, costUsd: 1, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: { token, arg } })
const ITEMS = [
  { number: 52, title: 'ticket', labels: ['port'], assignees: ['op'] },
  { number: 8, kind: 'pull-request' as const, title: 'ticket', headRefName: '52-ticket', assignees: ['op'] },
]

describe('stages', () => {
  it('a planned ticket waits on plan approval with its plan as the issue body', async () => {
    const fs = await diskWith(ticketOf({ repo: SCENARIO_REPO, ticket: 52, stage: 'plan', status: { kind: 'queued', reason: 'new', since: AT } }))
    const app = await scenarioRig({ fs, items: ITEMS })

    await app.consider(tickReport({ actionable: [actionable(52, 'ready', 'plan')] }))
    expect(app.stage.launches).toHaveLength(1)
    expect(await app.ticket(52)).toMatchObject({ stage: 'plan', status: { kind: 'running' } })

    await app.finish('hosted-1' as SessionKey, handback('plan-written', null), { kind: 'read', body: PLAN })
    await vi.waitFor(async () => expect(await app.ticket(52)).toMatchObject({ stage: 'plan', status: { kind: 'waiting-on-you', gate: 'plan-approval' } }))
    expect(app.github.body(52)).toBe(PLAN)
    expect(app.github.labels(52)).toEqual(['port', 'planning', 'needs you'])
  })

  it('an approved plan is implemented once, and the pull request it opens queues the review', async () => {
    const fs = await diskWith(ticketOf({ repo: SCENARIO_REPO, ticket: 52, stage: 'implement', status: { kind: 'queued', reason: 'new', since: AT } }))
    const app = await scenarioRig({ fs, items: ITEMS })

    await app.consider(tickReport({ actionable: [actionable(52, 'planApproved', 'impl')] }))
    expect(app.stage.launches).toHaveLength(1)
    expect(await app.ticket(52)).toMatchObject({ stage: 'implement', status: { kind: 'running' } })

    await app.finish('hosted-1' as SessionKey, handback('pr-opened', '#8'))
    await vi.waitFor(async () => expect(await app.ticket(52)).toMatchObject({ stage: 'review', status: { kind: 'queued' }, pr: { number: 8 } }))

    await app.consider(tickReport())
    expect(app.stage.launches).toHaveLength(1)
  })

  it('a hand-back naming a pull request that is not open on the ticket moves nothing', async () => {
    const fs = await diskWith(ticketOf({ repo: SCENARIO_REPO, ticket: 52, stage: 'implement', status: { kind: 'queued', reason: 'new', since: AT } }))
    const app = await scenarioRig({ fs, items: ITEMS })

    await app.consider(tickReport({ actionable: [actionable(52, 'planApproved', 'impl')] }))
    await app.finish('hosted-1' as SessionKey, handback('pr-opened', '#99'))
    await app.consider(tickReport())

    expect(await app.ticket(52)).toMatchObject({ stage: 'implement', status: { kind: 'running' } })
    expect(app.github.labels(52)).not.toContain('reviewing')
  })
})

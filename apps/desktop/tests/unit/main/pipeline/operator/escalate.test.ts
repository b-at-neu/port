import { describe, expect, it } from 'vitest'
import { escalateToHuman } from '@/main/pipeline/operator/escalate'
import type { EscalateToHumanParams } from '@/types/actions'
import { operatorRig, REPO_ID, type OperatorRigOptions } from '../../../../support/operator-rig'
import { ticketOf } from '../../../../support/tickets'

const READY: OperatorRigOptions = { items: [{ number: 52, labels: ['port', 'claude', 'plan approved'], assignees: ['op'] }], tickets: [ticketOf({ repo: REPO_ID, ticket: 52, stage: 'implement' })] }

async function escalate(options: OperatorRigOptions = READY, overrides: Partial<EscalateToHumanParams> = {}) {
  const rig = await operatorRig(options)
  const result = await escalateToHuman(rig.ctx, { entry: rig.entry, kind: 'issue', number: 52, viewer: 'op', body: '## Pipeline Escalation\nover budget', action: 'budget-escalate', auditDir: rig.auditDir, scratchDir: rig.scratchDir, ...overrides })
  return { rig, result }
}

describe('escalateToHuman', () => {
  it('swaps the label first, then comments — both applied', async () => {
    const { rig, result } = await escalate()
    expect(result.labels.kind).toBe('applied')
    expect(result.comment?.kind).toBe('applied')
    expect(rig.github.labels(52)).toContain('needs you')
    expect(rig.github.comments(52)).toEqual([expect.stringContaining('over budget')])
  })

  it('comments when the state moved but its label mirror failed', async () => {
    const rig = await operatorRig(READY)
    rig.github.failWrites(null, 'offline')
    const result = await escalateToHuman(rig.ctx, { entry: rig.entry, kind: 'issue', number: 52, viewer: 'op', body: 'over budget', action: 'budget-escalate', auditDir: rig.auditDir, scratchDir: rig.scratchDir })
    expect(result.labels.kind).toBe('mirror-failed')
    expect(result.comment?.kind).toBe('applied')
  })

  it.each([
    { name: 'the record holds no ticket', options: { ...READY, tickets: null } satisfies OperatorRigOptions, kind: 'item-unavailable' },
    { name: 'ownership is unreadable', options: { ...READY, unreadableOwnership: true } satisfies OperatorRigOptions, kind: 'ownership-unreadable' },
  ])('never comments when $name', async ({ options, kind }) => {
    const { rig, result } = await escalate(options)
    expect(result.labels.kind).toBe(kind)
    expect(result.comment).toBeNull()
    expect(rig.github.comments(52)).toEqual([])
  })

  it('swaps the label and posts nothing when the body is null', async () => {
    const { rig, result } = await escalate(READY, { body: null })
    expect(result.labels.kind).toBe('applied')
    expect(result.comment).toBeNull()
    expect(rig.github.comments(52)).toEqual([])
  })

  it('reports a failed comment without discarding the successful swap', async () => {
    const rig = await operatorRig(READY)
    rig.github.failComments('boom')
    const result = await escalateToHuman(rig.ctx, { entry: rig.entry, kind: 'issue', number: 52, viewer: 'op', body: 'over budget', action: 'budget-escalate', auditDir: rig.auditDir, scratchDir: rig.scratchDir })
    expect(result.labels.kind).toBe('applied')
    expect(result.comment).toMatchObject({ kind: 'write-failed', stderr: 'boom' })
  })
})

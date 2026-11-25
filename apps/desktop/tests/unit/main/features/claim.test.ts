import { describe, expect, it } from 'vitest'
import { callAction } from '../../../support/context'
import { operatorRig, REPO_ID } from '../../../support/operator-rig'

describe('claim actions', () => {
  it('preflight reports an issue the tracker cannot resolve', async () => {
    const rig = await operatorRig({ viewer: 'alice' })
    expect(await callAction(rig.ctx, 'claim.preflight', { repoId: REPO_ID, number: 93 })).toEqual({ kind: 'unresolved' })
  })

  it('apply refuses an issue the tracker does not have', async () => {
    const rig = await operatorRig({ viewer: 'alice' })
    expect(await callAction(rig.ctx, 'claim.apply', { repoId: REPO_ID, number: 93, planGate: 'review', confirmedAssignees: [] })).toEqual({ kind: 'refused', verdict: { kind: 'not-found' } })
  })
})

import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { resolveClaimApply, resolveClaimPreflight } from '@/main/features/claim/resolve'
import { createTestContext } from '../../../support/context'
import { operatorRig, REPO_ID } from '../../../support/operator-rig'

const ctx = createTestContext()
const APPLY = { repoId: REPO_ID, number: 1, planGate: 'review' as const, confirmedAssignees: [] }

describe('resolveClaimPreflight', () => {
  it.each([
    { name: 'a missing repoId', request: { repoId: undefined as unknown as RepoId, number: 1 }, message: "'claim:preflight' requires a non-empty 'repoId'" },
    { name: 'a non-integer number', request: { repoId: REPO_ID, number: 1.5 }, message: "'claim:preflight' requires 'number' to be a positive integer" },
    { name: 'a non-positive number', request: { repoId: REPO_ID, number: 0 }, message: "'claim:preflight' requires 'number' to be a positive integer" },
  ])('rejects $name', async ({ request, message }) => {
    await expect(resolveClaimPreflight(ctx, request)).rejects.toThrow(message)
  })

  it('passes a valid request through to claimPreflight', async () => {
    const rig = await operatorRig({ viewer: 'alice' })
    expect(await resolveClaimPreflight(rig.ctx, { repoId: REPO_ID, number: 93 })).toEqual({ kind: 'unresolved' })
  })
})

describe('resolveClaimApply', () => {
  it.each([
    { name: 'a missing repoId', request: { ...APPLY, repoId: undefined as unknown as RepoId }, message: "'claim:apply' requires a non-empty 'repoId'" },
    { name: 'a non-integer number', request: { ...APPLY, number: 1.5 }, message: "'claim:apply' requires 'number' to be a positive integer" },
    { name: 'a planGate outside PLAN_GATE_CHOICES', request: { ...APPLY, planGate: 'bogus' as never }, message: "'claim:apply' requires 'planGate' to be one of review, auto" },
    { name: 'confirmedAssignees that is not an array of strings', request: { ...APPLY, confirmedAssignees: [1 as never] }, message: "'claim:apply' requires 'confirmedAssignees' to be an array of strings" },
  ])('rejects $name', async ({ request, message }) => {
    await expect(resolveClaimApply(ctx, request, '/audit')).rejects.toThrow(message)
  })

  it('passes a valid request through to claimApply', async () => {
    const rig = await operatorRig({ viewer: 'alice' })
    expect(await resolveClaimApply(rig.ctx, { ...APPLY, number: 93 }, rig.auditDir)).toEqual({ kind: 'refused', verdict: { kind: 'not-found' } })
  })
})

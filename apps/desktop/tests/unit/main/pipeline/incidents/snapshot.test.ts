import { describe, expect, it } from 'vitest'
import { boundInputs, itemInputs } from '@/main/pipeline/incidents/snapshot'
import { INCIDENT_INPUTS_MAX_BYTES } from '@/types/incidents'
import { runOf, ticketAt } from '../../../../support/tickets'
import { item } from './fixtures'

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

describe('itemInputs', () => {
  it('carries identifiers and facts, and never a body, a comment or review text', () => {
    const secret = 'PRIVATE-TEXT-SHOULD-NEVER-APPEAR'
    const inputs = itemInputs(
      item({
        title: secret,
        ticket: ticketAt('review', { kind: 'running', runId: 'run-1' }, { runs: [runOf({ id: 'run-1', stage: 'review', startedAt: '2026-11-16T10:00:00.000Z' })] }),
        reviews: [{ body: `## Code Review — Cycle 1 · approved\n${secret}`, submittedAt: '2026-11-16T09:00:00Z', commitOid: 'f19c6d5' }],
        comments: [{ body: secret, createdAt: '2026-11-16T09:00:00Z' }],
        blockerComments: [{ body: secret, createdAt: '2026-11-16T09:00:00Z' } as never],
      }),
    )
    expect(JSON.stringify(inputs)).not.toContain(secret)
    expect(inputs).toMatchObject({ stage: 'review', status: 'running', assignees: ['op'], headRefOid: 'f19c6d5', claim: { stage: 'review', at: '2026-11-16T10:00:00.000Z' } })
    expect(inputs.reviews).toEqual([{ id: '2026-11-16T09:00:00Z', verdict: 'approved', commitOid: 'f19c6d5' }])
  })

  it('names checks by state and closing pull requests by number', () => {
    const inputs = itemInputs(
      item({
        checkRollup: [{ __typename: 'CheckRun', name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED', state: null, startedAt: null, completedAt: null, createdAt: null, url: 'https://secret.example' }],
        closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-x' }],
      }),
    )
    expect(inputs.checks).toEqual([{ name: 'ci', state: 'FAILURE' }])
    expect(inputs.closingPullRequests).toEqual([{ number: 780, state: 'OPEN' }])
    expect(JSON.stringify(inputs)).not.toContain('secret.example')
  })
})

describe('boundInputs', () => {
  it('leaves a small snapshot as it is', () => {
    expect(boundInputs({ a: 1, list: [1, 2] })).toEqual({ a: 1, list: [1, 2] })
  })

  it('truncates 500 reviews under the cap and says how many were dropped', () => {
    const reviews = Array.from({ length: 500 }, (_, index) => ({ id: `2026-11-16T09:${String(index).padStart(4, '0')}`, verdict: 'approved', commitOid: 'f19c6d5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }))
    const bounded = boundInputs({ headRefOid: 'f19c6d5', reviews })
    expect(bytes(bounded)).toBeLessThanOrEqual(INCIDENT_INPUTS_MAX_BYTES)
    const kept = bounded.reviews as readonly unknown[]
    expect(kept.at(-1)).toMatchObject({ dropped: expect.any(Number) as number })
    expect(bounded.headRefOid).toBe('f19c6d5')
  })

  it('keeps only the size when no list can shrink it', () => {
    const bounded = boundInputs({ blob: 'x'.repeat(10_000) })
    expect(bounded).toEqual({ truncated: true, bytes: expect.any(Number) as number })
    expect(bytes(bounded)).toBeLessThanOrEqual(INCIDENT_INPUTS_MAX_BYTES)
  })
})

import { describe, expect, it } from 'vitest'
import { ticketOfDisplay, type TicketOfDisplayParams } from '@/main/pipeline/state/seed'
import type { RepoId } from '@/utils/repos'

const AT = '2026-11-23T12:00:00.000Z'

const params = (overrides: Partial<TicketOfDisplayParams>): TicketOfDisplayParams => ({ repo: 'repo-a' as RepoId, ticket: 7, kind: 'issue', keys: ['port'], pr: null, at: AT, ...overrides })

describe('ticketOfDisplay', () => {
  it.each([
    { name: 'an item without the port marker is not in the pipeline', keys: ['implementing'] as const },
    { name: 'an item with no labels at all', keys: [] as const },
  ])('is null: $name', ({ keys }) => {
    expect(ticketOfDisplay(params({ keys }))).toBeNull()
  })

  it.each([
    { name: 'a bare issue is queued at plan', kind: 'issue' as const, keys: ['port'] as const, pr: null, stage: 'plan', status: { kind: 'queued', reason: 'new', since: AT } },
    { name: 'a bare pull request is queued at review', kind: 'pull-request' as const, keys: ['port'] as const, pr: { number: 7 }, stage: 'review', status: { kind: 'queued', reason: 'new', since: AT } },
    { name: 'planning runs the plan stage', kind: 'issue' as const, keys: ['port', 'planning'] as const, pr: null, stage: 'plan', status: { kind: 'running', runId: null } },
    { name: 'implementing runs the implement stage', kind: 'issue' as const, keys: ['port', 'implementing'] as const, pr: null, stage: 'implement', status: { kind: 'running', runId: null } },
    { name: 'reviewing runs the review stage', kind: 'pull-request' as const, keys: ['port', 'reviewing'] as const, pr: { number: 7 }, stage: 'review', status: { kind: 'running', runId: null } },
    { name: 'revising runs the revise stage', kind: 'pull-request' as const, keys: ['port', 'revising'] as const, pr: { number: 7 }, stage: 'revise', status: { kind: 'running', runId: null } },
    { name: 'approved waits on the merge gate', kind: 'pull-request' as const, keys: ['port', 'approved'] as const, pr: { number: 7 }, stage: 'merge', status: { kind: 'waiting-on-you', gate: 'merge', detail: '' } },
    { name: 'needs you escalates at the in-flight stage', kind: 'issue' as const, keys: ['port', 'implementing', 'needsYou'] as const, pr: null, stage: 'implement', status: { kind: 'waiting-on-you', gate: 'escalation', detail: '' } },
    { name: 'needs you alone escalates at the fallback stage', kind: 'issue' as const, keys: ['port', 'needsYou'] as const, pr: null, stage: 'plan', status: { kind: 'waiting-on-you', gate: 'escalation', detail: '' } },
  ])('$name', ({ kind, keys, pr, stage, status }) => {
    expect(ticketOfDisplay(params({ kind, keys, pr }))).toMatchObject({ repo: 'repo-a', ticket: 7, stage, status })
  })

  it('stamps the approval time on the pull request only when the approved label is worn', () => {
    expect(ticketOfDisplay(params({ kind: 'pull-request', keys: ['port', 'approved'], pr: { number: 9 } }))?.pr).toEqual({ number: 9, approvedAt: AT })
    expect(ticketOfDisplay(params({ kind: 'pull-request', keys: ['port', 'reviewing'], pr: { number: 9 } }))?.pr).toEqual({ number: 9, approvedAt: null })
  })
})

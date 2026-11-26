import { describe, expect, it } from 'vitest'
import { migrateV1, ticketOfKeys } from '@/main/pipeline/state/migrate'
import { NO_RUN_FILES, migrateRuns } from '@/main/pipeline/state/migrate-runs'
import { legacyKeysOf } from '@/main/pipeline/state/mirror'
import { parseFile } from '@/main/pipeline/state/model'
import type { Ticket } from '@/utils/pipeline/ticket'
import v1 from '../../../../fixtures/pipeline-state/v1.json'
import { NOW, REPO, ticketOf } from '../../../../support/tickets'

const toV3 = (raw: unknown): unknown => migrateRuns(migrateV1(1, raw), NO_RUN_FILES)
const file = parseFile(toV3(v1))
const ticketsOf = (repo: string): Ticket[] => Object.values(file.repositories[repo]?.tickets ?? {})
const ticket = (repo: string, number: number): Ticket | undefined => ticketsOf(repo).find((candidate) => candidate.ticket === number)

describe('migrate', () => {
  it('writes version 3, keeping both repositories', () => {
    expect(file.version).toBe(3)
    expect(Object.keys(file.repositories)).toEqual(['repo-a', 'repo-b'])
    expect(file.repositories['repo-a']?.seededAt).toBe('2026-11-01T09:00:00.000Z')
  })

  it('refuses any version it has no migration from', () => {
    expect(() => migrateV1(0, v1)).toThrow()
    expect(() => migrateV1(1, 'junk')).toThrow()
  })

  it('drops a repository record the terminal cockpit held, so it reseeds from labels', () => {
    const held = { version: 1, repositories: { 'repo-1': { seededAt: NOW, heldBy: 'terminal', items: {} } } }
    expect(parseFile(toV3(held)).repositories).toEqual({})
  })

  it('loses no item: every version-1 number is exactly one half of one ticket', () => {
    for (const [repo, record] of Object.entries(v1.repositories)) {
      const numbers = ticketsOf(repo).flatMap((t) => [...(t.pr?.number === t.ticket ? [] : [t.ticket]), ...(t.pr === null ? [] : [t.pr.number])])
      expect(numbers.sort((a, b) => a - b)).toEqual(Object.values(record.items).map((item) => item.number).sort((a, b) => a - b))
    }
  })

  it('loses no history row: each lands on its ticket with the keys prefixed by the half they came from', () => {
    for (const [repo, record] of Object.entries(v1.repositories)) {
      for (const item of Object.values(record.items)) {
        const owner = ticketsOf(repo).find((t) => t.ticket === item.number || t.pr?.number === item.number)
        for (const row of item.history) {
          expect(owner?.history).toContainEqual({ at: row.at, action: row.action, actor: row.actor, to: null, legacy: { add: row.add.map((key) => `${item.kind}:${key}`), remove: row.remove.map((key) => `${item.kind}:${key}`) } })
        }
      }
    }
  })

  interface Expected {
    readonly pr: number | null
    readonly stage: string
    readonly status: string
    readonly reason?: string
    readonly gate?: string
    readonly approved?: boolean
    readonly cycles?: number
    readonly failed?: boolean
    readonly autoPlan?: boolean
  }
  const GROUPS: readonly [string, number, Expected][] = [
    ['an issue with its linked pull request', 101, { pr: 201, stage: 'review', status: 'queued', reason: 'new' }],
    ['refreshBranch beside approved', 102, { pr: 202, stage: 'refresh', status: 'queued', approved: true, cycles: 1 }],
    ['a lone needsHuman, in the stage the newest state key was added in', 103, { pr: null, stage: 'implement', status: 'waiting-on-you', gate: 'escalation' }],
    ['an unmarked tracked item, which now counts as marked', 104, { pr: null, stage: 'plan', status: 'queued', reason: 'new' }],
    ['a pull request with no ticket, its own ticket, keeping its failure', 205, { pr: 205, stage: 'revise', status: 'queued', reason: 'changes-requested', cycles: 2, failed: true }],
    ['the newer of two pull requests on one issue', 106, { pr: 207, stage: 'review', status: 'running' }],
    ['the older of two pull requests on one issue, on its own', 206, { pr: 206, stage: 'review', status: 'queued', reason: 'new' }],
    ['a marker-only item, held where it stopped', 108, { pr: null, stage: 'implement', status: 'held' }],
    ['an auto-plan issue at its plan gate', 109, { pr: null, stage: 'plan', status: 'waiting-on-you', gate: 'plan-approval', autoPlan: true }],
  ]
  it.each(GROUPS)('groups %s', (_name, number, expected) => {
    const migrated = ticket('repo-a', number)
    expect(migrated).toMatchObject({ rev: 0, runs: [], stage: expected.stage, status: { kind: expected.status } })
    expect(migrated?.pr?.number ?? null).toBe(expected.pr)
    expect(migrated?.pr?.approvedAt !== null && migrated?.pr !== null).toBe(expected.approved === true)
    expect(migrated?.autoPlan).toBe(expected.autoPlan === true)
    expect(migrated?.reviewCycles).toBe(expected.cycles ?? 0)
    expect(migrated?.mirror.failure !== null).toBe(expected.failed === true)
    if (migrated?.status.kind === 'queued' && expected.reason !== undefined) expect(migrated.status.reason).toBe(expected.reason)
    if (migrated?.status.kind === 'waiting-on-you') expect(migrated.status.gate).toBe(expected.gate)
  })

  it('keeps one state key when a half held several, and records the rest in one history event', () => {
    const crowded = ticket('repo-b', 7)
    expect(crowded).toMatchObject({ stage: 'plan', status: { kind: 'running' } })
    expect(crowded?.history.at(-1)).toMatchObject({ action: 'migrate-v1', legacy: { add: [], remove: ['issue:ready', 'issue:needsHuman'] } })
  })

  it('reads an in-flight and a blocked implementation', () => {
    expect(ticket('repo-b', 5)).toMatchObject({ stage: 'implement', status: { kind: 'running' } })
    expect(ticket('repo-b', 6)).toMatchObject({ stage: 'implement', status: { kind: 'blocked' } })
  })
})

describe('ticketOfKeys is the inverse of legacyKeysOf', () => {
  const queued = (reason: 'new' | 'changes-requested') => ({ kind: 'queued' as const, reason, since: NOW })
  const waiting = (gate: 'plan-approval' | 'merge' | 'escalation') => ({ kind: 'waiting-on-you' as const, gate, detail: '' })
  const withPr = (approvedAt: string | null): Partial<Ticket> => ({ pr: { number: 900, approvedAt } })

  const SHAPES: readonly [string, Partial<Ticket>][] = [
    ['plan queued', { stage: 'plan', status: queued('new') }],
    ['plan changes requested', { stage: 'plan', status: queued('changes-requested') }],
    ['plan running', { stage: 'plan', status: { kind: 'running', runId: null } }],
    ['plan gate', { stage: 'plan', status: waiting('plan-approval'), autoPlan: true }],
    ['implement queued', { stage: 'implement', status: queued('new') }],
    ['implement running', { stage: 'implement', status: { kind: 'running', runId: null } }],
    ['implement blocked', { stage: 'implement', status: { kind: 'blocked', on: [], reason: '' } }],
    ['implement held', { stage: 'implement', status: { kind: 'held', on: 'paused', detail: 'stopped' } }],
    ['plan escalation', { stage: 'plan', status: waiting('escalation') }],
    ['review queued', { stage: 'review', status: queued('new'), ...withPr(null) }],
    ['review running', { stage: 'review', status: { kind: 'running', runId: null }, ...withPr(null) }],
    ['review escalation', { stage: 'review', status: waiting('escalation'), ...withPr(null) }],
    ['revise queued', { stage: 'revise', status: queued('changes-requested'), ...withPr(null) }],
    ['revise running', { stage: 'revise', status: { kind: 'running', runId: null }, ...withPr(null) }],
    ['refresh queued', { stage: 'refresh', status: queued('new'), ...withPr(null) }],
    ['refresh queued, approved', { stage: 'refresh', status: queued('new'), ...withPr(NOW) }],
    ['refresh running, approved', { stage: 'refresh', status: { kind: 'running', runId: null }, ...withPr(NOW) }],
    ['merge gate', { stage: 'merge', status: waiting('merge'), ...withPr(NOW) }],
    ['review held', { stage: 'review', status: { kind: 'held', on: 'paused', detail: 'stopped' }, ...withPr(null) }],
  ]

  it.each(SHAPES)('%s', (_name, shape) => {
    const original = ticketOf({ ticket: 843, ...shape })
    const { ticket: restored } = ticketOfKeys({
      repo: REPO,
      ticket: original.ticket,
      issueKeys: legacyKeysOf(original, 'issue') ?? [],
      pr: original.pr === null ? null : { number: original.pr.number, keys: legacyKeysOf(original, 'pull-request') ?? [], approvedAt: original.pr.approvedAt },
      history: [],
      at: NOW,
      mirrorFailure: null,
      reviewCycles: 0,
      stageHint: original.stage,
    })
    const summary = (t: Ticket) => ({
      stage: t.stage,
      kind: t.status.kind,
      gate: t.status.kind === 'waiting-on-you' ? t.status.gate : null,
      reason: t.status.kind === 'queued' ? t.status.reason : null,
      approved: t.pr?.approvedAt !== null && t.pr !== null,
      autoPlan: t.autoPlan,
    })
    expect(summary(restored)).toEqual(summary(original))
  })
})

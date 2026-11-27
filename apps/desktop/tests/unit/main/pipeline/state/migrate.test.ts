import { describe, expect, it } from 'vitest'
import { migrateV1 } from '@/main/pipeline/state/migrate'
import { NO_RUN_FILES, migrateRuns } from '@/main/pipeline/state/migrate-runs'
import { parseFile } from '@/main/pipeline/state/model'
import type { Ticket } from '@/utils/pipeline/ticket'
import v1 from '../../../../fixtures/pipeline-state/v1.json'
import { NOW } from '../../../../support/tickets'

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

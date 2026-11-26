import { describe, expect, it, vi } from 'vitest'
import { migrateRuns, NO_RUN_FILES, type RunFiles } from '@/main/pipeline/state/migrate-runs'
import { parseFile } from '@/main/pipeline/state/model'
import type { Run, Ticket } from '@/utils/pipeline/ticket'
import dispatch from '../../../../fixtures/pipeline-state/v2/dispatch.json'
import denials from '../../../../fixtures/pipeline-state/v2/stage-denials.json'
import v2 from '../../../../fixtures/pipeline-state/v2/pipeline-state.json'
import sessions from '../../../../fixtures/pipeline-state/v2/stage-sessions.json'

const files: RunFiles = { dispatch, sessions, denials }
const migrate = (overrides: Partial<RunFiles> = {}) => parseFile(migrateRuns(v2, { ...files, ...overrides }))
const ticketsOf = (file: ReturnType<typeof parseFile>): Ticket[] => Object.values(file.repositories).flatMap((record) => Object.values(record.tickets))
const runsOf = (file: ReturnType<typeof parseFile>): Run[] => ticketsOf(file).flatMap((ticket) => ticket.runs)
const run = (file: ReturnType<typeof parseFile>, id: string) => runsOf(file).find((candidate) => candidate.id === id)

describe('migrateRuns — the version 2 fixture', () => {
  const file = migrate()

  it('writes version 3 with the dispatch section copied across', () => {
    expect(file.version).toBe(3)
    expect(file.dispatch).toEqual({ 'repo-a': { state: 'dispatching', since: '2026-11-21T07:00:00.000Z' }, 'repo-b': { state: 'draining', since: '2026-11-21T07:30:00.000Z' } })
  })

  it('turns every registry id into a run on the ticket its number names', () => {
    expect(runsOf(file).map((r) => r.id).sort()).toEqual(['migrated-den-2', 'run-cleanup', 'run-live', 'run-network', 'run-orphan'])
    expect(file.repositories['repo-a']?.tickets['101']?.runs.map((r) => r.id)).toEqual(['run-live'])
    expect(file.repositories['repo-a']?.tickets['102']?.runs.map((r) => r.id)).toEqual(['run-cleanup'])
    expect(file.repositories['repo-b']?.tickets['5']?.runs.map((r) => r.id)).toEqual(['run-network'])
  })

  it('keeps a running entry open, and an interrupted one interrupted with its retries and reset', () => {
    expect(run(file, 'run-live')).toMatchObject({ endedAt: null, interruption: null, claudeSessionId: 'sdk-live', title: '#101 Add the thing', stage: 'implement', sessionKey: null })
    expect(run(file, 'run-network')).toMatchObject({ endedAt: '2026-11-21T09:20:00.000Z', networkRetries: 2, costUsd: 0.8, interruption: { reason: 'network', detail: 'EAI_AGAIN', resetsAt: '2026-11-21T09:35:00.000Z' } })
    expect(run(file, 'run-cleanup')).toMatchObject({ stage: 'review', agent: 'review', item: { kind: 'pull-request', number: 202 }, interruption: { reason: 'cleanup-failed' } })
  })

  it('puts every denial on exactly one run: the newest of its agent that started before it, else a run made for it', () => {
    const placed = runsOf(file).flatMap((r) => r.denials.map((d) => `${d.id}@${r.id}`))
    expect(placed.sort()).toEqual(['den-1@run-live', 'den-2@migrated-den-2'])
    expect(run(file, 'migrated-den-2')).toMatchObject({ sessionKey: null, worktree: null, endedAt: '2026-11-21T08:10:00.000Z', agent: 'plan', stage: 'plan' })
    expect(file.repositories['repo-a']?.tickets['103']?.runs.map((r) => r.id)).toEqual(['migrated-den-2'])
  })

  it('gives a run whose ticket the file lacks a stub ticket, paused at the run’s stage', () => {
    expect(file.repositories['repo-a']?.tickets['999']).toMatchObject({ stage: 'implement', status: { kind: 'held', on: 'paused' }, runs: [{ id: 'run-orphan' }] })
  })

  it('loses no ticket and no history, and leaves every rev alone', () => {
    const before = parseFile({ ...v2, version: 3, dispatch: {} })
    for (const original of ticketsOf(before)) {
      const kept = ticketsOf(file).find((candidate) => candidate.ticket === original.ticket && candidate.repo === original.repo)
      expect(kept).toMatchObject({ rev: original.rev, history: original.history, status: original.status, pr: original.pr })
    }
  })
})

describe('migrateRuns — files that are missing or unusable', () => {
  it('reads a missing or unparseable registry as no runs, and the denials then get runs of their own', () => {
    const file = migrate({ sessions: null })
    expect(runsOf(file).map((r) => r.id).sort()).toEqual(['migrated-den-1', 'migrated-den-2'])
  })

  it('reads a missing, version-1 or unparseable dispatch file as every repository paused', () => {
    expect(migrate({ dispatch: null }).dispatch).toEqual({})
    expect(migrate({ dispatch: { version: 1, draining: false } }).dispatch).toEqual({})
    expect(parseFile(migrateRuns(v2, NO_RUN_FILES)).dispatch).toEqual({})
  })

  it('drops, and logs by id, a run in a repository the file never seeded', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stray = { ...sessions.entries[0], id: 'run-stray', repoId: 'repo-z' }
    const file = migrate({ sessions: { version: 1, entries: [stray] } })
    expect(runsOf(file).map((r) => r.id)).not.toContain('run-stray')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('run-stray'))
    error.mockRestore()
  })

  it('keeps the last entry of a repeated id', () => {
    const [first] = sessions.entries
    const again = { ...first, claudeSessionId: 'sdk-newer' }
    const file = migrate({ sessions: { version: 1, entries: [first, again] } })
    expect(runsOf(file).filter((r) => r.id === 'run-live')).toMatchObject([{ claudeSessionId: 'sdk-newer' }])
  })

  it('throws for a file that is not an object, which the store maps to unreadable', () => {
    expect(() => migrateRuns('junk', NO_RUN_FILES)).toThrow()
  })
})

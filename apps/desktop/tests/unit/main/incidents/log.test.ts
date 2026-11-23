import { describe, expect, it } from 'vitest'
import { createIncidentLog, INCIDENT_LIMITS } from '@/main/incidents/log'
import { pathOps } from '@/main/platform/paths'
import type { IncidentDraft, IncidentFiles } from '@/types/incidents'
import { memory } from './fixtures'

const DAY_MS = 24 * 60 * 60 * 1000
const START = Date.parse('2026-11-16T12:00:00.000Z')

function draft(number: number, overrides: Partial<IncidentDraft> = {}): IncidentDraft {
  return {
    bucket: 'escalation',
    stage: 'needsHuman',
    condition: 'cycle-cap',
    decision: { action: 'observe-cycle-cap', detail: 'cycle-cap', intended: null },
    inputs: { observedHead: 'f19c6d5' },
    repo: 'o/r',
    number,
    kind: 'pull-request',
    outcome: { kind: 'applied' },
    related: { audit: ['write-1'], tick: null },
    ...overrides,
  }
}

function rig(files: IncidentFiles, clock: { ms: number }, limits: typeof INCIDENT_LIMITS = INCIDENT_LIMITS) {
  let next = 0
  return createIncidentLog({ dir: '/data', now: () => new Date(clock.ms), newId: () => `id-${String(++next)}`, files, limits })
}

describe('createIncidentLog', () => {
  it('appends one versioned record per incident, with its signature and an unset resolvedBy', async () => {
    const { files } = memory()
    const log = rig(files, { ms: START })
    await log.record(draft(789))
    const read = await log.read()
    expect(read).toMatchObject({ ok: true, malformed: 0, pruned: null })
    expect(read.ok && read.records).toEqual([
      expect.objectContaining({ v: 1, id: 'id-1', at: '2026-11-16T12:00:00.000Z', repo: 'o/r', number: 789, kind: 'pull-request', bucket: 'escalation', signature: 'escalation:needsHuman:cycle-cap', resolvedBy: null, outcome: { kind: 'applied' } }),
    ])
  })

  it('survives a restart: a new log over the same directory reads what the first wrote', async () => {
    const { files } = memory()
    await rig(files, { ms: START }).record(draft(1))
    const restarted = await rig(files, { ms: START + 1000 }).read()
    expect(restarted.ok && restarted.records.map((record) => record.number)).toEqual([1])
  })

  it('reads a missing file as empty, and counts a malformed line instead of dropping it silently', async () => {
    const { files, store } = memory()
    const log = rig(files, { ms: START })
    expect(await log.read()).toMatchObject({ ok: true, records: [], malformed: 0 })
    store.set(pathOps.join('/data', 'incidents.jsonl'),`${JSON.stringify({ v: 1, at: '2026-11-16T12:00:00.000Z' })}\nnot json\n`)
    expect(await log.read()).toMatchObject({ ok: true, malformed: 1 })
  })

  it('swallows a failed append, so the caller never sees it', async () => {
    const { files } = memory({ append: true })
    await expect(rig(files, { ms: START }).record(draft(1))).resolves.toBeUndefined()
  })

  it('reports a read failure as a typed error, never an empty list', async () => {
    const { files } = memory()
    const failing: IncidentFiles = { ...files, stat: () => Promise.resolve({ ok: false, kind: 'permission-denied', message: 'EACCES' }) }
    expect(await rig(failing, { ms: START }).read()).toMatchObject({ ok: false, kind: 'permission-denied', message: 'EACCES' })
  })
})

describe('retention', () => {
  it('drops the oldest first past the size limit, and the read reports that older entries existed', async () => {
    const { files } = memory()
    const clock = { ms: START }
    const log = rig(files, clock, { ...INCIDENT_LIMITS, maxBytes: 2000, pruneToBytes: 1200 })
    for (let number = 1; number <= 12; number++) {
      clock.ms += 1000
      await log.record(draft(number))
    }
    const read = await log.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const kept = read.records.map((record) => record.number)
    expect(kept.length).toBeLessThan(12)
    expect(kept).toEqual([...kept].sort((a, b) => a - b))
    expect(kept.at(-1)).toBe(12)
    expect(read.pruned).not.toBeNull()
    expect((read.pruned?.count ?? 0) + kept.length).toBe(12)
    expect(read.pruned?.through).toBe(new Date(START + 1000 * (12 - kept.length)).toISOString())
  })

  it('drops an entry older than 90 days on the next append', async () => {
    const { files } = memory()
    const clock = { ms: START }
    await rig(files, clock).record(draft(1))
    clock.ms = START + 91 * DAY_MS
    const later = rig(files, clock)
    await later.record(draft(2))
    const read = await later.read()
    expect(read.ok && read.records.map((record) => record.number)).toEqual([2])
    expect(read.ok && read.pruned).toMatchObject({ count: 1, through: '2026-11-16T12:00:00.000Z' })
  })

  it('keeps every record while the file is within both limits', async () => {
    const { files } = memory()
    const clock = { ms: START }
    const log = rig(files, clock)
    for (let number = 1; number <= 5; number++) await log.record(draft(number))
    const read = await log.read()
    expect(read.ok && read.records).toHaveLength(5)
    expect(read.ok && read.pruned).toBeNull()
  })

  it('lands every record when appends race a prune', async () => {
    const { files } = memory()
    const clock = { ms: START }
    const log = rig(files, clock, { ...INCIDENT_LIMITS, maxBytes: 1500, pruneToBytes: 900 })
    await Promise.all(Array.from({ length: 30 }, (_, index) => log.record(draft(index + 1))))
    const read = await log.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.records.length + (read.pruned?.count ?? 0)).toBe(30)
    expect(new Set(read.records.map((record) => record.id)).size).toBe(read.records.length)
  })
})

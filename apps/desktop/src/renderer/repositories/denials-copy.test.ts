import { describe, expect, it } from 'vitest'
import { actorAttributionPill, attributionLineCopy, burstPillCopy, cappedLineCopy, emptyLogCopy, metaStripCopy, noEntriesCopy, readFailedCopy } from './denials-copy'
import type { AttributionTally, SessionAttribution } from '../../../shared/local/inspect'
import type { DenialActor, DenialSummary } from '../../../shared/local/types'

function summary(overrides: Partial<DenialSummary> = {}): DenialSummary {
  return { agentDenials: 0, railDenials: 0, misses: 0, gateClears: 0, hookErrors: 0, legacy: 0, malformed: 0, total: 0, ...overrides }
}

function tally(overrides: Partial<AttributionTally> = {}): AttributionTally {
  return { agentAttributed: 0, sessionAttributed: 0, sessionUnresolved: 0, attributionUnavailable: 0, unattributable: 0, ...overrides }
}

describe('metaStripCopy', () => {
  it('names denials, misses, rail holds and hook errors from window', () => {
    expect(metaStripCopy(summary({ agentDenials: 3, misses: 5, railDenials: 2, hookErrors: 1 }))).toBe('3 denials · 5 allowlist misses · 2 rail holds · 1 hook error')
  })
})

describe('cappedLineCopy', () => {
  it('names the newest N of the whole-file total, with whole-log denial and miss totals', () => {
    const copy = cappedLineCopy(500, summary({ total: 3232, agentDenials: 100, railDenials: 50, misses: 1078 }))
    expect(copy).toBe('Showing the newest 500 of 3232 log lines. Totals for the whole log: 150 denials, 1078 misses.')
  })
})

describe('attributionLineCopy', () => {
  it('names unresolved sessions when any exist', () => {
    expect(attributionLineCopy(tally({ sessionUnresolved: 2, attributionUnavailable: 1 }))).toBe("3 entries come from sessions port couldn't identify.")
  })

  it('returns null when nothing is unresolved', () => {
    expect(attributionLineCopy(tally())).toBeNull()
  })
})

describe('burstPillCopy', () => {
  it('reports the count and the window length in minutes', () => {
    expect(burstPillCopy(5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z')).toBe('Burst: 5 in 2m')
  })

  it('floors to at least 1 minute', () => {
    expect(burstPillCopy(3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')).toBe('Burst: 3 in 1m')
  })
})

describe('actorAttributionPill', () => {
  it('names a stage agent, subagent and subagent signal verbatim, idle', () => {
    expect(actorAttributionPill({ kind: 'stage-agent', agent: 'impl-agent' }, null)).toEqual({ label: 'impl-agent', tone: 'idle' })
    expect(actorAttributionPill({ kind: 'subagent', agentType: 'Explore' }, null)).toEqual({ label: 'Explore', tone: 'idle' })
    expect(actorAttributionPill({ kind: 'subagent-signal', signal: 'blocked' }, null)).toEqual({ label: 'blocked', tone: 'idle' })
  })

  it('names an attributed session by role and label', () => {
    const attribution: SessionAttribution = { kind: 'attributed', role: 'implement', repoId: null, label: '#38 fix the thing', lastActivityAt: '2026-01-01T00:00:00.000Z' }
    expect(actorAttributionPill({ kind: 'session', sessionId: 's1' }, attribution)).toEqual({ label: 'implement · #38 fix the thing', tone: 'idle' })
  })

  it('names an attributed session by role alone when it has no label', () => {
    const attribution: SessionAttribution = { kind: 'attributed', role: 'cockpit', repoId: null, label: null, lastActivityAt: '2026-01-01T00:00:00.000Z' }
    expect(actorAttributionPill({ kind: 'session', sessionId: 's1' }, attribution)).toEqual({ label: 'cockpit', tone: 'idle' })
  })

  it('flags an unknown session with attention, and a scan gap idle', () => {
    expect(actorAttributionPill({ kind: 'session', sessionId: 's1' }, { kind: 'unknown-session' })).toEqual({ label: 'Unknown session', tone: 'attention' })
    expect(actorAttributionPill({ kind: 'session', sessionId: 's1' }, { kind: 'attribution-unavailable', reason: 'not-scanned' })).toEqual({ label: 'Sessions not scanned', tone: 'idle' })
    expect(actorAttributionPill({ kind: 'session', sessionId: 's1' }, { kind: 'attribution-unavailable', reason: 'scan-failed' })).toEqual({ label: 'Session scan failed', tone: 'idle' })
  })

  it('names an unattributed actor and a malformed (null) actor the same way', () => {
    const unattributed: DenialActor = { kind: 'unattributed', raw: 'bare-uuid' }
    expect(actorAttributionPill(unattributed, null)).toEqual({ label: 'Unattributed', tone: 'idle' })
    expect(actorAttributionPill(null, null)).toEqual({ label: 'Unattributed', tone: 'idle' })
  })
})

describe('empty/failure copy', () => {
  it('each names its own state in one sentence', () => {
    expect(emptyLogCopy().length).toBeGreaterThan(0)
    expect(noEntriesCopy().length).toBeGreaterThan(0)
    expect(readFailedCopy('/repo/.agents/denials.log', 'EACCES')).toBe("Couldn't read the denial log at /repo/.agents/denials.log: EACCES.")
  })
})

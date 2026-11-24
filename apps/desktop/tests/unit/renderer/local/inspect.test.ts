import { describe, expect, it } from 'vitest'
import type { SessionRecord, SessionScan } from '@/types/sessions'
import { actorKeyOf, BURST_MIN_COUNT, BURST_WINDOW_MS, inspectDenials, shapeOf } from '@/renderer/local/inspect'
import type { DenialActor, DenialEntry, DenialsRead, DenialSummary } from '@/types/local'

const AT = '2026-01-01T00:00:00.000Z'

function entry(overrides: Partial<DenialEntry> = {}): DenialEntry {
  return {
    raw: 'raw-line',
    form: 'current',
    timestamp: AT,
    decision: 'deny',
    actor: { kind: 'stage-agent', agent: 'impl-agent' },
    subject: 'git push origin main',
    ...overrides,
  }
}

function emptySummary(overrides: Partial<DenialSummary> = {}): DenialSummary {
  return { agentDenials: 0, railDenials: 0, misses: 0, gateClears: 0, hookErrors: 0, legacy: 0, malformed: 0, total: 0, ...overrides }
}

function present(entries: readonly DenialEntry[], overrides: Partial<Extract<DenialsRead, { present: true }>> = {}): Extract<DenialsRead, { present: true }> {
  return { ok: true, present: true, path: '/repo/.agents/denials.log', entries, summary: emptySummary({ total: entries.length }), capped: false, readAt: AT, ...overrides }
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 's',
    repoId: null,
    cwd: null,
    worktreePath: null,
    role: 'cockpit',
    roleEvidence: 'stage-agent',
    itemNumber: null,
    customTitle: null,
    summary: null,
    firstPrompt: null,
    gitBranch: null,
    lastActivityAt: AT,
    idleMs: 0,
    activity: 'active',
    agentIds: [],
    ...overrides,
  }
}

function scanOk(sessions: readonly SessionRecord[]): SessionScan {
  return { ok: true, sessions, agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 1, scannedAt: AT }
}

const SCAN_FAILED: SessionScan = { ok: false, kind: 'claude-home-missing', message: 'no claude home', scannedAt: AT }

function inspected(read: DenialsRead, sessions: SessionScan | null = null) {
  const result = inspectDenials({ read, sessions })
  if (!result.ok || !result.present) throw new Error('expected a present log')
  return result
}

describe('inspectDenials — mirrors DenialsRead', () => {
  it.each([
    ['an absent log stays absent', { ok: true, present: false, path: '/p', readAt: AT }],
    ['a failure passes straight through', { ok: false, kind: 'permission-denied', message: 'EACCES', path: '/p', readAt: AT }],
  ] as const)('%s', (_label, read) => {
    expect(inspectDenials({ read, sessions: null })).toEqual(read)
  })

  it('passes the whole-file summary through by reference', () => {
    const read = present([entry()])
    const result = inspected(read)
    expect(result.summary).toBe(read.summary)
    expect(result.analysed).toBe(1)
  })
})

describe('inspectDenials — attribution', () => {
  const sessionEntry = entry({ actor: { kind: 'session', sessionId: 'sess-1' } })

  it('counts each actor kind into its bucket, with the buckets summing to analysed', () => {
    const actors: readonly (DenialActor | null)[] = [
      { kind: 'stage-agent', agent: 'impl-agent' },
      { kind: 'subagent', agentType: 'Explore' },
      { kind: 'subagent-signal', signal: 'x' },
      { kind: 'session', sessionId: 'known' },
      { kind: 'session', sessionId: 'unknown' },
      { kind: 'unattributed', raw: 'bare-uuid' },
      null,
    ]
    const result = inspected(present(actors.map((actor) => entry({ actor, ...(actor === null ? { form: 'malformed', decision: null, subject: null } : {}) }))), scanOk([sessionRecord({ sessionId: 'known' })]))
    expect(result.attribution).toEqual({ agentAttributed: 3, sessionAttributed: 1, sessionUnresolved: 1, attributionUnavailable: 0, unattributable: 2 })
    const { agentAttributed, sessionAttributed, sessionUnresolved, attributionUnavailable, unattributable } = result.attribution
    expect(agentAttributed + sessionAttributed + sessionUnresolved + attributionUnavailable + unattributable).toBe(result.analysed)
  })

  it.each([
    ['a known session', scanOk([sessionRecord({ sessionId: 'sess-1', role: 'implement', customTitle: 'title' })]), { kind: 'attributed', role: 'implement', repoId: null, label: 'title', lastActivityAt: AT }],
    ['a session the scan does not hold', scanOk([sessionRecord({ sessionId: 'other' })]), { kind: 'unknown-session' }],
    ['no scan', null, { kind: 'attribution-unavailable', reason: 'not-scanned' }],
    ['a failed scan, never unknown-session', SCAN_FAILED, { kind: 'attribution-unavailable', reason: 'scan-failed' }],
  ] as const)('resolves %s', (_label, sessions, expected) => {
    expect(inspected(present([sessionEntry]), sessions).byActor[0]?.attribution).toEqual(expected)
  })

  it('caps the label at 120 characters, preferring customTitle', () => {
    const long = 'x'.repeat(150)
    const sessions = scanOk([sessionRecord({ sessionId: 'sess-1', customTitle: long, summary: 'summary text', firstPrompt: 'first prompt' })])
    const attribution = inspected(present([sessionEntry]), sessions).byActor[0]?.attribution
    expect(attribution?.kind === 'attributed' ? attribution.label : null).toBe(long.slice(0, 120))
  })

  it('files a legacy line with no decision under undecided, never deny or miss', () => {
    const result = inspected(present([entry({ form: 'legacy', decision: null, actor: { kind: 'unattributed', raw: 'session-abc' } })]))
    expect(result.byActor[0]?.counts).toEqual({ deny: 0, miss: 0, gateClear: 0, hookError: 0, undecided: 1, total: 1 })
  })

  it('reports zero agent attribution for an all-human-session log', () => {
    const read = present(
      [
        entry({ decision: 'miss', actor: { kind: 'session', sessionId: 'human-1' } }),
        entry({ decision: 'deny', actor: { kind: 'session', sessionId: 'human-2' }, subject: 'gh issue edit 42' }),
      ],
      { summary: emptySummary({ total: 2, misses: 1, railDenials: 1 }) },
    )
    const result = inspected(read)
    expect(result.attribution.agentAttributed).toBe(0)
    expect(result.byActor.every((group) => group.actor?.kind === 'session')).toBe(true)
  })
})

describe('inspectDenials — timestamps', () => {
  it('counts an unparseable timestamp in totals but not in first and last seen', () => {
    const read = present([
      entry({ timestamp: AT, subject: 'same-shape' }),
      entry({ timestamp: 'not-a-real-timestamp', subject: 'same-shape' }),
      entry({ timestamp: '2026-01-01T00:00:02.000Z', subject: 'same-shape' }),
    ])
    const group = inspected(read).byShape[0]
    expect([group?.counts.total, group?.firstSeen, group?.lastSeen]).toEqual([3, AT, '2026-01-01T00:00:02.000Z'])
  })
})

describe('inspectDenials — bursts', () => {
  const SUBJECT = 'node /repo/scripts/checks.mjs'
  function deny(second: number, agentType = 'busy-agent', overrides: Partial<DenialEntry> = {}): DenialEntry {
    return entry({ timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`, actor: { kind: 'subagent', agentType }, subject: SUBJECT, ...overrides })
  }
  const farApart = [deny(0), ...[2, 4].map((n) => deny(0, 'busy-agent', { timestamp: new Date(Date.parse(AT) + BURST_WINDOW_MS * n).toISOString() }))]

  it.each([
    ['at exactly BURST_MIN_COUNT', Array.from({ length: BURST_MIN_COUNT }, (_, i) => deny(i)), true],
    ['one below BURST_MIN_COUNT', Array.from({ length: BURST_MIN_COUNT - 1 }, (_, i) => deny(i)), false],
    ['across two actors that each fall short', [deny(0, 'a'), deny(1, 'a'), deny(2, 'b'), deny(3, 'b')], false],
    ['on miss lines', Array.from({ length: BURST_MIN_COUNT + 2 }, (_, i) => deny(i, 'busy-agent', { decision: 'miss' })), false],
    ['outside BURST_WINDOW_MS', farApart, false],
  ] as const)('fires %s: %s', (_label, entries, fires) => {
    expect(inspected(present(entries)).byShape[0]?.burst !== null).toBe(fires)
  })
})

describe('shapeOf', () => {
  it.each([
    ['an empty subject', '', '(empty)'],
    ['a blank subject', '   ', '(empty)'],
    ['a flag, dropped', 'gh issue view --json', 'gh issue view'],
    ['an issue number, dropped', 'gh issue view 42', 'gh issue view'],
    ['a Windows path', 'open C:\\Users\\op\\file.txt', 'open <path>'],
    ['a POSIX path', 'cat /home/op/file.txt', 'cat <path>'],
    ['identifier tokens, kept', 'git status', 'git status'],
    ['a quoted string', 'git "quoted string"', 'git <arg>'],
    ['consecutive placeholders, collapsed', 'node scripts/checks.mjs 2>&1 | tail -100', 'node <path> <arg> tail'],
    ['a bare write-deny path', '.claude/settings.json', '<path>'],
  ] as const)('maps %s', (_label, subject, shape) => {
    expect(shapeOf(subject)).toBe(shape)
  })

  it('keeps only the first 4 mapped tokens', () => {
    expect(shapeOf('a b c d e f g h').split(' ')).toHaveLength(4)
  })
})

describe('actorKeyOf', () => {
  it('is collision-free across every actor kind, including null', () => {
    const keys = [
      actorKeyOf({ kind: 'stage-agent', agent: 'impl-agent' }, 'raw'),
      actorKeyOf({ kind: 'subagent', agentType: 'Explore' }, 'raw'),
      actorKeyOf({ kind: 'subagent-signal', signal: 'x' }, 'raw'),
      actorKeyOf({ kind: 'session', sessionId: 'abc' }, 'raw'),
      actorKeyOf({ kind: 'unattributed', raw: 'bare-uuid' }, 'raw'),
      actorKeyOf(null, 'a whole malformed line'),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('inspectDenials — window', () => {
  const entries = [entry({ decision: 'miss', actor: { kind: 'session', sessionId: 'human-1' } }), entry()]

  it('summarizes only the analysed entries when the read is capped', () => {
    const read = present(entries, { capped: true, summary: emptySummary({ total: 20, misses: 9, agentDenials: 1 }) })
    const result = inspected(read)
    expect(result.window).toEqual(emptySummary({ total: 2, misses: 1, agentDenials: 1 }))
    expect(result.summary).toBe(read.summary)
    expect(result.byActor.reduce((sum, group) => sum + group.counts.miss, 0)).toBe(result.window.misses)
  })

  it('matches summary exactly when the read is not capped', () => {
    const result = inspected(present(entries, { summary: emptySummary({ total: 2, misses: 1, agentDenials: 1 }) }))
    expect(result.window).toEqual(result.summary)
  })
})

describe('inspectDenials — sort orders', () => {
  it('sorts actors by deny count, then total, then recency, then key', () => {
    const subagent = (agentType: string, timestamp: string) => entry({ actor: { kind: 'subagent', agentType }, timestamp })
    const read = present([subagent('z-actor', AT), subagent('a-actor', AT), subagent('busy-actor', '2026-01-01T00:00:05.000Z'), subagent('busy-actor', '2026-01-01T00:00:06.000Z')])
    expect(inspected(read).byActor.map((g) => g.key)).toEqual(['subagent:busy-actor', 'subagent:a-actor', 'subagent:z-actor'])
  })

  it('sorts a burst shape first', () => {
    const burst = Array.from({ length: BURST_MIN_COUNT }, (_, i) => entry({ timestamp: `2026-01-01T00:00:0${String(i)}.000Z`, actor: { kind: 'subagent', agentType: 'burster' }, subject: 'aaa command' }))
    const quieter = ['other', 'other2'].map((agentType, i) => entry({ timestamp: `2026-01-01T00:05:0${String(i)}.000Z`, actor: { kind: 'subagent', agentType }, subject: 'zzz command' }))
    const result = inspected(present([...quieter, ...burst]))
    expect(result.byShape[0]?.shape).toBe(shapeOf('aaa command'))
    expect(result.byShape[0]?.burst).not.toBeNull()
  })
})

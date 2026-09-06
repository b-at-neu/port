import { describe, expect, it } from 'vitest'
import type { SessionRecord, SessionScan } from '../sessions/types'
import { actorKeyOf, BURST_MIN_COUNT, BURST_WINDOW_MS, inspectDenials, shapeOf } from './inspect'
import type { DenialActor, DenialDecision, DenialEntry, DenialsRead, DenialSummary } from './types'

// The real-repository-log case lives in `main/local/inspect.test.ts`, not
// here: reading the log itself is `readDenials` (`main/local/denials.ts`),
// and this file must import nothing from `src/main/` — the same purity
// `inspect.ts` itself rests on (Decision 2) — or `pnpm typecheck:web` fails,
// since `tsconfig.web.json` type-checks every file under `src/shared/**/*`
// including its own transitive imports.

// --- Fixture builders ------------------------------------------------------
// Every helper below builds the minimum shape `inspectDenials` needs; tests
// override only the fields the case is about.

let rawCounter = 0
function entry(overrides: Partial<DenialEntry> = {}): DenialEntry {
  rawCounter += 1
  return {
    raw: overrides.raw ?? `raw-line-${rawCounter}`,
    form: overrides.form ?? 'current',
    timestamp: overrides.timestamp === undefined ? '2026-01-01T00:00:00.000Z' : overrides.timestamp,
    decision: overrides.decision === undefined ? 'deny' : overrides.decision,
    actor: overrides.actor === undefined ? { kind: 'stage-agent', agent: 'impl-agent' } : overrides.actor,
    subject: overrides.subject === undefined ? 'git push origin main' : overrides.subject,
  }
}

function emptySummary(overrides: Partial<DenialSummary> = {}): DenialSummary {
  return { agentDenials: 0, railDenials: 0, misses: 0, gateClears: 0, hookErrors: 0, legacy: 0, malformed: 0, total: 0, ...overrides }
}

function present(entries: readonly DenialEntry[], overrides: Partial<Extract<DenialsRead, { present: true }>> = {}): Extract<DenialsRead, { present: true }> {
  return {
    ok: true,
    present: true,
    path: '/repo/.agents/denials.log',
    entries,
    summary: emptySummary({ total: entries.length }),
    capped: false,
    readAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

let sessionCounter = 0
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  sessionCounter += 1
  return {
    sessionId: overrides.sessionId ?? `session-${sessionCounter}`,
    repoId: overrides.repoId ?? null,
    cwd: overrides.cwd ?? null,
    worktreePath: overrides.worktreePath ?? null,
    role: overrides.role ?? 'cockpit',
    roleEvidence: overrides.roleEvidence ?? 'stage-agent',
    itemNumber: overrides.itemNumber ?? null,
    customTitle: overrides.customTitle ?? null,
    summary: overrides.summary ?? null,
    firstPrompt: overrides.firstPrompt ?? null,
    gitBranch: overrides.gitBranch ?? null,
    lastActivityAt: overrides.lastActivityAt ?? '2026-01-01T00:00:00.000Z',
    idleMs: overrides.idleMs ?? 0,
    activity: overrides.activity ?? 'active',
    agentIds: overrides.agentIds ?? [],
  }
}

function scanOk(sessions: readonly SessionRecord[]): SessionScan {
  return { ok: true, sessions, agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 1, scannedAt: '2026-01-01T00:00:00.000Z' }
}

function scanFailed(): SessionScan {
  return { ok: false, kind: 'claude-home-missing', message: 'no claude home', scannedAt: '2026-01-01T00:00:00.000Z' }
}

// --- Three-arm union mirrors DenialsRead exactly ---------------------------

describe('inspectDenials — mirrors DenialsRead', () => {
  it('present: false stays present: false, not folded into "no denials"', () => {
    const read: DenialsRead = { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: '2026-01-01T00:00:00.000Z' }
    expect(inspectDenials({ read, sessions: null })).toEqual(read)
  })

  it('ok: false passes the failure straight through', () => {
    const read: DenialsRead = { ok: false, kind: 'permission-denied', message: 'EACCES', path: '/repo/.agents/denials.log', readAt: '2026-01-01T00:00:00.000Z' }
    const result = inspectDenials({ read, sessions: null })
    expect(result).toEqual(read)
  })

  it('ok: true / present: true carries summary, attribution, groupings, analysed, and capped', () => {
    const read = present([entry()])
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.summary).toBe(read.summary) // passed through by reference, never recomputed
    expect(result.analysed).toBe(1)
    expect(result.capped).toBe(false)
  })
})

// --- Actor kinds reach the right AttributionTally bucket -------------------

describe('inspectDenials — attribution tally', () => {
  it('counts each of the five actor kinds into the right bucket', () => {
    const read = present([
      entry({ actor: { kind: 'stage-agent', agent: 'impl-agent' } }),
      entry({ actor: { kind: 'subagent', agentType: 'Explore' } }),
      entry({ actor: { kind: 'subagent-signal', signal: 'some-signal' } }),
      entry({ actor: { kind: 'session', sessionId: 'known-session' } }),
      entry({ actor: { kind: 'unattributed', raw: 'bare-uuid' } }),
    ])
    const result = inspectDenials({ read, sessions: scanOk([sessionRecord({ sessionId: 'known-session' })]) })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.attribution).toEqual({
      agentAttributed: 3,
      sessionAttributed: 1,
      sessionUnresolved: 0,
      attributionUnavailable: 0,
      unattributable: 1,
    })
  })

  it('counts a malformed line (actor: null) into unattributable, not dropped', () => {
    const read = present([entry({ form: 'malformed', decision: null, actor: null, subject: null })])
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.attribution.unattributable).toBe(1)
    expect(result.analysed).toBe(1)
    expect(result.byShape).toHaveLength(0) // no subject, so it never forms a shape
  })

  it('a legacy line with no decision field lands in undecided, never deny or miss', () => {
    const read = present([entry({ form: 'legacy', decision: null, actor: { kind: 'unattributed', raw: 'session-abc' } })])
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    const group = result.byActor[0]
    expect(group?.counts).toEqual({ deny: 0, miss: 0, gateClear: 0, hookError: 0, undecided: 1, total: 1 })
  })
})

// --- SessionAttribution's three arms ---------------------------------------

describe('inspectDenials — SessionAttribution', () => {
  const sessionEntry = entry({ actor: { kind: 'session', sessionId: 'sess-1' } })

  it('resolves attributed when the session id is in the scan', () => {
    const result = inspectDenials({ read: present([sessionEntry]), sessions: scanOk([sessionRecord({ sessionId: 'sess-1', role: 'implement', customTitle: 'title' })]) })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byActor[0]?.attribution).toEqual({ kind: 'attributed', role: 'implement', repoId: null, label: 'title', lastActivityAt: '2026-01-01T00:00:00.000Z' })
  })

  it('resolves unknown-session when the scan succeeded but has no matching id', () => {
    const result = inspectDenials({ read: present([sessionEntry]), sessions: scanOk([sessionRecord({ sessionId: 'some-other-session' })]) })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byActor[0]?.attribution).toEqual({ kind: 'unknown-session' })
  })

  it('resolves attribution-unavailable: not-scanned when sessions is null', () => {
    const result = inspectDenials({ read: present([sessionEntry]), sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byActor[0]?.attribution).toEqual({ kind: 'attribution-unavailable', reason: 'not-scanned' })
  })

  it('resolves attribution-unavailable: scan-failed when the scan itself failed, never unknown-session', () => {
    const result = inspectDenials({ read: present([sessionEntry]), sessions: scanFailed() })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byActor[0]?.attribution).toEqual({ kind: 'attribution-unavailable', reason: 'scan-failed' })
  })

  it('caps the label at 120 characters, preferring customTitle over summary over firstPrompt', () => {
    const long = 'x'.repeat(150)
    const result = inspectDenials({
      read: present([sessionEntry]),
      sessions: scanOk([sessionRecord({ sessionId: 'sess-1', customTitle: long, summary: 'summary text', firstPrompt: 'first prompt' })]),
    })
    if (!result.ok || !result.present) throw new Error('expected present')
    const attribution = result.byActor[0]?.attribution
    if (attribution?.kind !== 'attributed') throw new Error('expected attributed')
    expect(attribution.label).toHaveLength(120)
    expect(attribution.label).toBe(long.slice(0, 120))
  })
})

// --- #63 regression: miss lines and session-actor deny lines are not agent denials

describe('inspectDenials — #63 regression', () => {
  it('an all-human-session log (miss lines plus session-actor deny) reports zero agent attribution', () => {
    const read = present(
      [
        entry({ decision: 'miss', actor: { kind: 'session', sessionId: 'human-1' }, subject: 'git push origin main' }),
        entry({ decision: 'miss', actor: { kind: 'session', sessionId: 'human-1' }, subject: 'gh issue list' }),
        entry({ decision: 'deny', actor: { kind: 'session', sessionId: 'human-2' }, subject: 'gh issue edit 42 --remove-label needs human' }),
      ],
      { summary: emptySummary({ total: 3, misses: 2, railDenials: 1 }) },
    )
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.attribution.agentAttributed).toBe(0)
    expect(result.summary.agentDenials).toBe(0)
    // Every group in byActor is attributed to a session, never an agent —
    // the reading that made the old report 90% noise.
    for (const group of result.byActor) {
      expect(group.actor?.kind).toBe('session')
    }
  })
})

// --- Tally invariant: the five buckets always sum to `analysed` ------------

describe('inspectDenials — tally invariant', () => {
  function sumTally(tally: { agentAttributed: number; sessionAttributed: number; sessionUnresolved: number; attributionUnavailable: number; unattributable: number }): number {
    return tally.agentAttributed + tally.sessionAttributed + tally.sessionUnresolved + tally.attributionUnavailable + tally.unattributable
  }

  it('sums to analysed over a mixed fixture', () => {
    const read = present([
      entry({ actor: { kind: 'stage-agent', agent: 'review-agent' } }),
      entry({ decision: 'miss', actor: { kind: 'subagent', agentType: 'Explore' } }),
      entry({ actor: { kind: 'session', sessionId: 'known' } }),
      entry({ actor: { kind: 'session', sessionId: 'unknown' } }),
      entry({ form: 'legacy', decision: null, actor: { kind: 'unattributed', raw: 'legacy-uuid' } }),
      entry({ form: 'malformed', decision: null, actor: null, subject: null }),
    ])
    const result = inspectDenials({ read, sessions: scanOk([sessionRecord({ sessionId: 'known' })]) })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(sumTally(result.attribution)).toBe(result.analysed)
  })

  it('sums to analysed over a generated fixture of arbitrary actor kinds', () => {
    const actors: readonly DenialActor[] = [
      { kind: 'stage-agent', agent: 'plan-agent' },
      { kind: 'subagent', agentType: 'general-purpose' },
      { kind: 'subagent-signal', signal: 'x' },
      { kind: 'session', sessionId: 'a' },
      { kind: 'session', sessionId: 'b' },
      { kind: 'unattributed', raw: 'r' },
    ]
    const decisions: readonly DenialDecision[] = ['deny', 'miss', 'gate-clear', 'hook-error']
    const entries = actors.flatMap((actor, i) => decisions.map((decision) => entry({ actor, decision, subject: `cmd-${i}` })))
    const read = present(entries)
    const result = inspectDenials({ read, sessions: scanOk([sessionRecord({ sessionId: 'a' })]) })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(sumTally(result.attribution)).toBe(result.analysed)
    expect(result.analysed).toBe(entries.length)
  })
})

// --- Timestamps: unparseable never sets first/last, still counts -----------

describe('inspectDenials — timestamps', () => {
  it('an entry with an unparseable timestamp counts in totals but not first/last', () => {
    const read = present([
      entry({ timestamp: '2026-01-01T00:00:00.000Z', subject: 'same-shape' }),
      entry({ timestamp: 'not-a-real-timestamp', subject: 'same-shape' }),
      entry({ timestamp: '2026-01-01T00:00:02.000Z', subject: 'same-shape' }),
    ])
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    const group = result.byShape[0]
    expect(group?.counts.total).toBe(3)
    expect(group?.firstSeen).toBe('2026-01-01T00:00:00.000Z')
    expect(group?.lastSeen).toBe('2026-01-01T00:00:02.000Z')
  })
})

// --- Bursts ------------------------------------------------------------

describe('inspectDenials — bursts', () => {
  function denyEntry(second: number, actorRaw = 'busy-agent'): DenialEntry {
    return entry({
      timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
      actor: { kind: 'subagent', agentType: actorRaw },
      subject: 'node /repo/scripts/checks.mjs',
    })
  }

  it('fires at exactly BURST_MIN_COUNT inside the window', () => {
    const entries = Array.from({ length: BURST_MIN_COUNT }, (_, i) => denyEntry(i))
    const result = inspectDenials({ read: present(entries), sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byShape[0]?.burst).not.toBeNull()
    expect(result.byShape[0]?.burst?.count).toBe(BURST_MIN_COUNT)
  })

  it('does not fire one entry below BURST_MIN_COUNT', () => {
    const entries = Array.from({ length: BURST_MIN_COUNT - 1 }, (_, i) => denyEntry(i))
    const result = inspectDenials({ read: present(entries), sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byShape[0]?.burst).toBeNull()
  })

  it('does not combine two actors that individually fall short', () => {
    const entries = [denyEntry(0, 'agent-a'), denyEntry(1, 'agent-a'), denyEntry(2, 'agent-b'), denyEntry(3, 'agent-b')]
    const result = inspectDenials({ read: present(entries), sessions: null, burstMinCount: 3 })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byShape[0]?.burst).toBeNull()
  })

  it('never fires on miss lines, only deny', () => {
    const entries = Array.from({ length: BURST_MIN_COUNT + 2 }, (_, i) => ({ ...denyEntry(i), decision: 'miss' as const }))
    const result = inspectDenials({ read: present(entries), sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byShape[0]?.burst).toBeNull()
  })

  it('does not fire when entries fall outside BURST_WINDOW_MS', () => {
    const farApart = [
      denyEntry(0),
      entry({ timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + BURST_WINDOW_MS * 2).toISOString(), actor: { kind: 'subagent', agentType: 'busy-agent' }, subject: 'node /repo/scripts/checks.mjs' }),
      entry({ timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + BURST_WINDOW_MS * 4).toISOString(), actor: { kind: 'subagent', agentType: 'busy-agent' }, subject: 'node /repo/scripts/checks.mjs' }),
    ]
    const result = inspectDenials({ read: present(farApart), sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byShape[0]?.burst).toBeNull()
  })
})

// --- shapeOf grammar --------------------------------------------------------

describe('shapeOf', () => {
  it('returns (empty) for an empty subject', () => {
    expect(shapeOf('')).toBe('(empty)')
    expect(shapeOf('   ')).toBe('(empty)')
  })

  it('drops a flag token entirely, unlike an ordinary argument', () => {
    expect(shapeOf('gh issue view --json')).toBe(shapeOf('gh issue view'))
  })

  it('drops an all-digits token, so an issue number never fragments a group', () => {
    expect(shapeOf('gh issue view 42')).toBe(shapeOf('gh issue view 99'))
  })

  it('maps a token containing / or \\ to <path>, including a Windows path', () => {
    expect(shapeOf('open C:\\Users\\op\\file.txt')).toBe('open <path>')
    expect(shapeOf('cat /home/op/file.txt')).toBe('cat <path>')
  })

  it('keeps an identifier-shaped token verbatim', () => {
    expect(shapeOf('git status')).toBe('git status')
  })

  it('maps anything else to <arg>', () => {
    expect(shapeOf('git "quoted string"')).toBe('git <arg>')
  })

  it('collapses consecutive identical placeholders to one', () => {
    expect(shapeOf('node scripts/checks.mjs 2>&1 | tail -100')).toBe('node <path> <arg> tail')
  })

  it('keeps only the first 4 mapped tokens and caps at 80 characters', () => {
    const shape = shapeOf('a b c d e f g h')
    expect(shape.split(' ')).toHaveLength(4)
    expect(shape.length).toBeLessThanOrEqual(80)
  })

  it('worked example: node <path>', () => {
    expect(shapeOf('node /home/op/.claude/plugins/cache/port/port/0.1.0/templates/artifacts.mjs')).toBe('node <path>')
  })

  it('worked example: node <path> <arg> tail, identically for -100 and -60', () => {
    const a = shapeOf('node scripts/checks.mjs 2>&1 | tail -100')
    const b = shapeOf('node scripts/checks.mjs 2>&1 | tail -60')
    expect(a).toBe('node <path> <arg> tail')
    expect(a).toBe(b)
  })

  it('worked example: a write-deny subject becomes its own group, <path>', () => {
    expect(shapeOf('.claude/settings.json')).toBe('<path>')
  })
})

// --- actorKeyOf --------------------------------------------------------

describe('actorKeyOf', () => {
  it('is stable and collision-free across every actor kind, including null', () => {
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

// --- Sort orders -------------------------------------------------------

describe('inspectDenials — sort orders', () => {
  it('byActor sorts by [deny desc, total desc, lastSeen desc, key asc], with deliberate ties', () => {
    const read = present([
      entry({ actor: { kind: 'subagent', agentType: 'z-actor' }, timestamp: '2026-01-01T00:00:00.000Z' }),
      entry({ actor: { kind: 'subagent', agentType: 'a-actor' }, timestamp: '2026-01-01T00:00:00.000Z' }),
      entry({ actor: { kind: 'subagent', agentType: 'busy-actor' }, timestamp: '2026-01-01T00:00:05.000Z' }),
      entry({ actor: { kind: 'subagent', agentType: 'busy-actor' }, timestamp: '2026-01-01T00:00:06.000Z' }),
    ])
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    // busy-actor has 2 denies (beats the two 1-deny ties), then a-actor before z-actor by key.
    expect(result.byActor.map((g) => g.key)).toEqual(['subagent:busy-actor', 'subagent:a-actor', 'subagent:z-actor'])
  })

  it('byShape sorts burst first, then by [deny desc, total desc, lastSeen desc, shape asc]', () => {
    const burstEntries = Array.from({ length: BURST_MIN_COUNT }, (_, i) =>
      entry({ timestamp: `2026-01-01T00:00:0${i}.000Z`, actor: { kind: 'subagent', agentType: 'burster' }, subject: 'aaa command' }),
    )
    const quieterEntries = [
      entry({ timestamp: '2026-01-01T00:05:00.000Z', actor: { kind: 'subagent', agentType: 'other' }, subject: 'zzz command', decision: 'deny' }),
      entry({ timestamp: '2026-01-01T00:05:01.000Z', actor: { kind: 'subagent', agentType: 'other2' }, subject: 'zzz command', decision: 'deny' }),
    ]
    const read = present([...quieterEntries, ...burstEntries])
    const result = inspectDenials({ read, sessions: null })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.byShape[0]?.shape).toBe(shapeOf('aaa command'))
    expect(result.byShape[0]?.burst).not.toBeNull()
  })
})

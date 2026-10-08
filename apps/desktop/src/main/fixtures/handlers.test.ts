import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcChannel } from '../../shared/ipc'
import { needsYouItems } from '../../shared/board/needs-you'
import type { RepoId } from '../../shared/repos'
import { fixtureHandlers } from './handlers'
import { STREAMING_KEY } from './sessions'

const WIDGETS = 'fixture-acme-widgets' as RepoId

// A representative request for every channel whose request is not `void` —
// fixture handlers never validate, so any well-typed shape exercises them.
const SAMPLE_REQUESTS: Partial<Record<IpcChannel, unknown>> = {
  'repos:remove': { id: 'fixture-acme-widgets' },
  'worktrees:report': { id: 'fixture-acme-widgets' },
  'transcript:tail:open': { sessionId: 'fixture-session', agentId: null },
  'transcript:tail:poll': { tailId: 'fixture-tail' },
  'transcript:tail:close': { tailId: 'fixture-tail' },
  'search:query': { query: 'reports', scope: { kind: 'all' } },
  'board:refresh': {},
  'claim:preflight': { repoId: 'fixture-acme-widgets', number: 41 },
  'claim:apply': { repoId: 'fixture-acme-widgets', number: 41, planGate: 'review', confirmedAssignees: [] },
  'item:action': { repoId: 'fixture-acme-widgets', kind: 'issue', number: 44, action: 'retry', expectedStage: null },
  'dispatch:control': { command: 'drain' },
  'dispatch:claim:set': { repoId: 'fixture-acme-widgets', held: true },
  'runtime:probe': { repoId: 'fixture-acme-widgets' },
  'gate:preflight': { repoId: 'fixture-acme-widgets', number: 41 },
  'gate:claim:read': { repoId: 'fixture-acme-widgets' },
  'gate:claim:set': { repoId: 'fixture-acme-widgets', held: true },
  'gate:answer': { repoId: 'fixture-acme-widgets', number: 41, decision: 'approve', feedback: null, skipComment: false },
  'relay:copy': { text: 'hello' },
  'session:start': { repoId: 'fixture-acme-widgets', mode: { kind: 'fresh' } },
  'session:send': { sessionKey: 'hosted-1', text: 'hello' },
  'session:interrupt': { sessionKey: 'hosted-1' },
  'session:close': { sessionKey: 'hosted-1' },
  'session:attach': { sessionKey: 'hosted-1' },
  'session:permission:answer': { sessionKey: 'hosted-1', permissionId: 'p1', decision: 'deny', message: null },
  'session:invoke': { sessionKey: 'hosted-1', name: 'pipeline', args: '' },
  'session:dismiss': { sessionKey: 'hosted-1' },
  'session:capacity:set': { limit: 4 },
  'session:restore': { restoreId: 'r1' },
  'session:restore:discard': { restoreId: null },
  'backlog:list': { repoId: 'fixture-acme-widgets' },
}

describe.each(['populated', 'empty'] as const)('fixtureHandlers (%s scenario)', (scenario) => {
  const now = new Date('2026-09-05T14:00:00.000Z')
  const handlers = fixtureHandlers(now, scenario)

  it('has a handler for every IPC channel', () => {
    for (const channel of IPC_CHANNELS) {
      expect(typeof handlers[channel]).toBe('function')
    }
  })

  it('returns without throwing for every channel, called with a representative request', () => {
    for (const channel of IPC_CHANNELS) {
      const request = SAMPLE_REQUESTS[channel]
      expect(() => (handlers[channel] as (req: unknown) => unknown)(request)).not.toThrow()
    }
  })

  it('reports repos:list with one ready and one not-ready entry', () => {
    const result = handlers['repos:list'](undefined)
    if (!result.ok) throw new Error('fixture repos:list unexpectedly failed')
    expect(result.repositories).toHaveLength(2)
    expect(result.repositories.filter((r) => 'config' in r)).toHaveLength(1)
    expect(result.repositories.filter((r) => !('config' in r))).toHaveLength(1)
  })

  it('reports runtime:preflight as unverified', () => {
    expect(handlers['runtime:preflight'](undefined).diagnosis).toBe('unverified')
  })

  describe('board:snapshot', () => {
    const snapshot = handlers['board:snapshot'](undefined)

    it('has one ok repository and one not-ready repository', () => {
      expect(snapshot.state.repositories).toHaveLength(2)
      expect(snapshot.state.repositories.filter((r) => r.ok)).toHaveLength(1)
      expect(snapshot.state.repositories.filter((r) => !r.ok)).toHaveLength(1)
    })

    it.runIf(scenario === 'populated')('has one item each with status gated, in-flight, waiting, and terminal', () => {
      const ok = snapshot.state.repositories.find((r) => r.ok)
      if (ok === undefined || !ok.ok) throw new Error('fixture board carries no ok repository')
      const statuses = new Set(ok.items.map((item) => item.status))
      expect(statuses.has('gated')).toBe(true)
      expect(statuses.has('in-flight')).toBe(true)
      expect(statuses.has('waiting')).toBe(true)
      expect(statuses.has('terminal')).toBe(true)
    })

    it.runIf(scenario === 'empty')('produces an empty Needs you list', () => {
      expect(needsYouItems(snapshot, now)).toHaveLength(0)
    })

    it.runIf(scenario === 'populated')('produces a non-empty Needs you list', () => {
      expect(needsYouItems(snapshot, now).length).toBeGreaterThan(0)
    })

    it('never times anything after now', () => {
      const ok = snapshot.state.repositories.find((r) => r.ok)
      if (ok === undefined || !ok.ok) throw new Error('fixture board carries no ok repository')
      const github = ok.freshness.github
      if ('at' in github) expect(Date.parse(github.at)).toBeLessThanOrEqual(now.getTime())
      for (const item of ok.items) {
        for (const agent of item.agents) {
          expect(Date.parse(agent.lastActivityAt)).toBeLessThanOrEqual(now.getTime())
        }
      }
    })

    it.runIf(scenario === 'populated')('holds #52 as unowned, for a held note on the Board', () => {
      const report = snapshot.tick.find((r) => r.held.some((h) => h.number === 52))
      expect(report?.held.find((h) => h.number === 52)?.reason).toBe('unowned')
    })
  })

  it('reports gate:preflight as answerable, with a plan body carrying a heading, list, code, table and link', () => {
    const response = handlers['gate:preflight']({ repoId: WIDGETS, number: 41 })
    if (response.kind !== 'resolved') throw new Error('fixture gate:preflight did not resolve')
    expect(response.verdict.kind).toBe('answerable')
    const plan = response.preflight.planMarkdown ?? ''
    expect(plan).toContain('## Overview')
    expect(plan).toContain('1. ')
    expect(plan).toContain('```ts')
    expect(plan).toContain('| Column | Type |')
    expect(plan).toContain('[the report spec]')
  })

  it('reports claim:preflight as claimable', () => {
    const response = handlers['claim:preflight']({ repoId: WIDGETS, number: 44 })
    if (response.kind !== 'resolved') throw new Error('fixture claim:preflight did not resolve')
    expect(response.verdict.kind).toBe('claimable')
  })

  it('reports worktrees:report with one each of active, done, dirty and locked, plus one orphan dir', () => {
    const report = handlers['worktrees:report']({ id: WIDGETS })
    if (!report.ok) throw new Error('fixture worktrees:report unexpectedly failed')
    const states = report.worktrees.map((w) => w.state).sort()
    expect(states).toEqual(['active', 'dirty', 'done', 'locked'])
    expect(report.orphanDirs).toHaveLength(1)
  })

  it.runIf(scenario === 'populated')('reports session:list with three snapshots covering streaming, ended, and starting', () => {
    const snapshots = handlers['session:list'](undefined)
    expect(snapshots.map((s) => s.phase).sort()).toEqual(['ended', 'starting', 'streaming'])
    expect(snapshots.find((s) => s.phase === 'ended')?.end?.diagnosis).not.toBeNull()
  })

  // The permission dialog is app-wide, so its one fixture session is kept out of the
  // populated scenario's own session:list — see sessions.ts's own note on fixturePermissionSnapshots.
  it.runIf(scenario === 'empty')('reports session:list with the one pending-permission snapshot', () => {
    const snapshots = handlers['session:list'](undefined)
    expect(snapshots.map((s) => s.phase)).toEqual(['ready'])
    expect(snapshots[0]?.pendingPermissions).toHaveLength(1)
  })

  it('reports session:attach for the streaming fixture with a user, assistant, tool-call and thinking entry', () => {
    const result = handlers['session:attach']({ sessionKey: STREAMING_KEY })
    if (!result.ok) throw new Error('fixture session:attach unexpectedly failed')
    expect(result.entries.map((e) => e.type)).toEqual(['user-text', 'assistant-text', 'tool-call', 'thinking'])
  })

  it('reports sessions:scan with at least one session and one agent', () => {
    const scan = handlers['sessions:scan'](undefined)
    if (!scan.ok) throw new Error('fixture sessions:scan unexpectedly failed')
    expect(scan.sessions.length).toBeGreaterThan(0)
    expect(scan.agents.length).toBeGreaterThan(0)
  })

  it('reports search:query with at least one group and hit', () => {
    const result = handlers['search:query']({ query: 'widgets', scope: { kind: 'all' } })
    if (!result.ok) throw new Error('fixture search:query unexpectedly failed')
    expect(result.groups.length).toBeGreaterThan(0)
    expect(result.groups[0]?.hits.length).toBeGreaterThan(0)
  })
})

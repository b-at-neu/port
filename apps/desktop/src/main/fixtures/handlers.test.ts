import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcChannel } from '../../shared/ipc'
import { fixtureHandlers } from './handlers'

// A representative request for every channel whose request is not `void` —
// fixture handlers never validate, so any well-typed shape exercises them.
const SAMPLE_REQUESTS: Partial<Record<IpcChannel, unknown>> = {
  'repos:remove': { id: 'fixture-acme-widgets' },
  'worktrees:report': { id: 'fixture-acme-widgets' },
  'transcript:read': { sessionId: 'fixture-session', agentId: null },
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

describe('fixtureHandlers', () => {
  const now = new Date('2026-09-05T14:00:00.000Z')
  const handlers = fixtureHandlers(now)

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

    it('has one item each with status gated, in-flight, waiting, and terminal', () => {
      const ok = snapshot.state.repositories.find((r) => r.ok)
      if (ok === undefined || !ok.ok) throw new Error('fixture board carries no ok repository')
      const statuses = new Set(ok.items.map((item) => item.status))
      expect(statuses.has('gated')).toBe(true)
      expect(statuses.has('in-flight')).toBe(true)
      expect(statuses.has('waiting')).toBe(true)
      expect(statuses.has('terminal')).toBe(true)
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
  })
})

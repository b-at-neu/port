import { describe, expect, it } from 'vitest'
import type { OffloadRequest, OffloadResponse } from '@/types/offload'
import { createWorkerEngine } from '@/main/offload/client'

type Listener = (value: never) => void

function fakeWorker() {
  const listeners = new Map<string, Listener>()
  const sent: OffloadRequest[] = []
  return {
    sent,
    port: {
      postMessage: (request: OffloadRequest) => void sent.push(request),
      on: (event: string, listener: Listener) => void listeners.set(event, listener),
    },
    reply: (response: OffloadResponse) => (listeners.get('message') as (r: OffloadResponse) => void)(response),
    crash: (message: string) => (listeners.get('error') as (e: Error) => void)(new Error(message)),
    exit: (code: number) => (listeners.get('exit') as (c: number) => void)(code),
  }
}

const now = () => new Date('2026-01-01T00:00:00.000Z')

function setup() {
  const workers: ReturnType<typeof fakeWorker>[] = []
  const engine = createWorkerEngine({
    now,
    spawn: () => {
      const worker = fakeWorker()
      workers.push(worker)
      return worker.port
    },
  })
  return { engine, workers }
}

describe('createWorkerEngine', () => {
  it('spawns lazily and correlates each reply to its request by id', async () => {
    const { engine, workers } = setup()
    expect(workers).toHaveLength(0)
    const first = engine.listSessions()
    const second = engine.tailPoll({ tailId: 't' })
    const worker = workers[0]!
    expect(worker.sent.map((request) => request.op)).toEqual(['listSessions', 'tailPoll'])
    worker.reply({ id: 2, ok: true, value: 'second' })
    worker.reply({ id: 1, ok: true, value: { ok: true, sessions: [] } })
    expect(await second).toBe('second')
    expect(await first).toEqual({ ok: true, sessions: [] })
  })

  it('a crash settles every pending request into its failure shape, and the next call respawns', async () => {
    const { engine, workers } = setup()
    const refresh = engine.refreshGithub({ repoId: 'r' as never, repo: { owner: 'o', name: 'n' }, vocabulary: {} as never })
    const scan = engine.scanSessions({ repos: [] })
    const projection = engine.project({ repositories: [] })
    workers[0]!.crash('out of memory')
    expect(await refresh).toEqual({ ok: false, at: now().toISOString(), error: 'state worker stopped: out of memory' })
    expect(await scan).toEqual({ ok: false, kind: 'sdk-failed', message: 'state worker stopped: out of memory', scannedAt: now().toISOString() })
    await expect(projection).rejects.toThrow('state worker stopped: out of memory')

    void engine.listSessions()
    expect(workers).toHaveLength(2)
  })

  it('an exit event after an error does not fail the respawned worker', async () => {
    const { engine, workers } = setup()
    void engine.listSessions()
    workers[0]!.crash('boom')
    const pending = engine.search({ scan: {} as never, indexDir: '/d', query: 'q', scope: { kind: 'all' } })
    workers[0]!.exit(1)
    workers[1]!.reply({ id: 2, ok: true, value: 'found' })
    expect(await pending).toBe('found')
  })

  it('an error reply rejects the call, and a closed tail on a dead worker is a no-op', async () => {
    const { engine, workers } = setup()
    const open = engine.tailOpen({ sessionId: 's', agentId: null })
    workers[0]!.reply({ id: 1, ok: false, message: 'unreadable' })
    await expect(open).rejects.toThrow('unreadable')
    const close = engine.tailClose({ tailId: 't' })
    workers[0]!.exit(1)
    await expect(close).resolves.toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { OFFLOAD_OPS } from '@/types/offload'
import type { StateEngine } from '@/types/offload'
import { createInProcessEngine } from '@/main/offload/engine'
import { handleRequest } from '@/main/offload/dispatch'
import { fakeGit, readyEntry } from '../../../fixtures/watcher-harness'

const reader = () => Promise.resolve({ ok: true as const, sessions: [] })

describe('handleRequest', () => {
  it('routes every op to the engine method of the same name', async () => {
    const seen: string[] = []
    const engine = Object.fromEntries(OFFLOAD_OPS.map((op) => [op, () => (seen.push(op), Promise.resolve(op))])) as unknown as StateEngine
    for (const [id, op] of OFFLOAD_OPS.entries()) {
      expect(await handleRequest(engine, { id, op, params: {} })).toEqual({ id, ok: true, value: op })
    }
    expect(seen).toEqual([...OFFLOAD_OPS])
  })

  it('answers an unknown op with an error reply', async () => {
    const engine = createInProcessEngine({ sessionReader: reader })
    expect(await handleRequest(engine, { id: 7, op: 'nope', params: null })).toEqual({ id: 7, ok: false, message: "unknown offload op 'nope'" })
  })

  it('turns an engine throw into an error reply', async () => {
    const engine = { ...createInProcessEngine(), listSessions: () => Promise.reject(new Error('boom')) }
    expect(await handleRequest(engine, { id: 1, op: 'listSessions', params: undefined })).toEqual({ id: 1, ok: false, message: 'boom' })
  })

  it('a projection survives a structured clone', async () => {
    const engine = createInProcessEngine({ sessionReader: reader, git: fakeGit({ worktreeList: 0 }) })
    const repositories = [readyEntry('repo-a', '/tmp/does-not-exist', 'o/a')]
    const reply = await handleRequest(engine, { id: 1, op: 'project', params: { repositories } })
    expect(structuredClone(reply)).toEqual(reply)
    expect(structuredClone(repositories)).toEqual(repositories)
  })
})

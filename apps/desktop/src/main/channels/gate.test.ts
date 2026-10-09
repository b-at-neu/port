import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { GateAnswerResponse, GatePreflightResponse } from '../../shared/gate/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { RegistryDeps } from '../registry'
import { resolveGateAnswer, resolveGatePreflight } from './gate'
import type { GateChannelDeps } from './gate'

const REPO_ID = 'repo-1' as unknown as RepoId
const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by the gate channel')
  },
  chooseDirectory: () => Promise.resolve(null),
}

function depsWith(overrides: Partial<GateChannelDeps>): GateChannelDeps {
  return {
    gatePreflight: () => {
      throw new Error('gatePreflight should not be invoked in this case')
    },
    gateAnswer: () => {
      throw new Error('gateAnswer should not be invoked in this case')
    },
    refresh: () => {
      throw new Error('refresh should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveGatePreflight', () => {
  it('rejects a missing repoId', async () => {
    await expect(resolveGatePreflight(registryDeps, { repoId: undefined as unknown as RepoId, number: 1 }, depsWith({}))).rejects.toThrow(
      "'gate:preflight' requires a non-empty 'repoId'",
    )
  })

  it('rejects a non-positive number', async () => {
    await expect(resolveGatePreflight(registryDeps, { repoId: REPO_ID, number: 0 }, depsWith({}))).rejects.toThrow(
      "'gate:preflight' requires 'number' to be a positive integer",
    )
  })

  it('passes a valid request through to gatePreflight', async () => {
    const response: GatePreflightResponse = { kind: 'unresolved', ownership: { kind: 'absent' } }
    let received: unknown
    const deps = depsWith({
      gatePreflight: (params) => {
        received = params
        return Promise.resolve(response)
      },
    })
    const result = await resolveGatePreflight(registryDeps, { repoId: REPO_ID, number: 148 }, deps)
    expect(result).toBe(response)
    expect(received).toEqual({ registryDeps, repoId: REPO_ID, number: 148 })
  })
})

describe('resolveGateAnswer', () => {
  it('rejects a missing repoId', async () => {
    await expect(
      resolveGateAnswer(registryDeps, { repoId: undefined as unknown as RepoId, number: 1, decision: 'approve', feedback: null, skipComment: false }, '/audit', '/scratch', depsWith({})),
    ).rejects.toThrow("'gate:answer' requires a non-empty 'repoId'")
  })

  it('rejects a non-positive number', async () => {
    await expect(
      resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 0, decision: 'approve', feedback: null, skipComment: false }, '/audit', '/scratch', depsWith({})),
    ).rejects.toThrow("'gate:answer' requires 'number' to be a positive integer")
  })

  it('rejects a decision outside GATE_DECISIONS', async () => {
    await expect(
      resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 1, decision: 'bogus' as never, feedback: null, skipComment: false }, '/audit', '/scratch', depsWith({})),
    ).rejects.toThrow("'gate:answer' requires 'decision' to be one of approve, request-changes")
  })

  it('rejects a non-boolean skipComment', async () => {
    await expect(
      resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 1, decision: 'approve', feedback: null, skipComment: 'no' as never }, '/audit', '/scratch', depsWith({})),
    ).rejects.toThrow("'gate:answer' requires 'skipComment' to be a boolean")
  })

  it('rejects request-changes with no feedback and skipComment false', async () => {
    await expect(
      resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 1, decision: 'request-changes', feedback: null, skipComment: false }, '/audit', '/scratch', depsWith({})),
    ).rejects.toThrow("'gate:answer' requires a non-empty 'feedback'")
  })

  it('allows request-changes with no feedback when skipComment is true (the retry-the-swap-alone case)', async () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'no-op' } }
    const deps = depsWith({ gateAnswer: () => Promise.resolve(response) })
    const result = await resolveGateAnswer(
      registryDeps,
      { repoId: REPO_ID, number: 1, decision: 'request-changes', feedback: null, skipComment: true },
      '/audit',
      '/scratch',
      deps,
    )
    expect(result).toBe(response)
  })

  it('never forces a refresh on a non-applied outcome', async () => {
    let refreshed = false
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'no-op' } }
    const deps = depsWith({
      gateAnswer: () => Promise.resolve(response),
      refresh: () => {
        refreshed = true
        return Promise.resolve({} as BoardSnapshot)
      },
    })
    await resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 1, decision: 'approve', feedback: null, skipComment: false }, '/audit', '/scratch', deps)
    expect(refreshed).toBe(false)
  })

  it('forces a github refresh after an applied label outcome, before returning', async () => {
    let refreshRequest: unknown
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'applied', argv: [] } }
    const deps = depsWith({
      gateAnswer: () => Promise.resolve(response),
      refresh: (request) => {
        refreshRequest = request
        return Promise.resolve({} as BoardSnapshot)
      },
    })
    const result = await resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 148, decision: 'approve', feedback: null, skipComment: false }, '/audit', '/scratch', deps)
    expect(result).toBe(response)
    expect(refreshRequest).toEqual({ repoId: REPO_ID, source: 'github' })
  })

  it('swallows a refresh failure rather than masking the write result', async () => {
    const response: GateAnswerResponse = { kind: 'answered', comment: null, labels: { kind: 'applied', argv: [] } }
    const deps = depsWith({
      gateAnswer: () => Promise.resolve(response),
      refresh: () => {
        throw new Error('transient github error')
      },
    })
    const result = await resolveGateAnswer(registryDeps, { repoId: REPO_ID, number: 148, decision: 'approve', feedback: null, skipComment: false }, '/audit', '/scratch', deps)
    expect(result).toBe(response)
  })
})

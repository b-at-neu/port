import { describe, expect, it } from 'vitest'
import { fetchGatePreflight } from '@/main/github/gate'
import { fakeTransport, httpFail, httpOk } from '../../../fixtures/github-http'

describe('fetchGatePreflight', () => {
  it('resolves an Issue node with its body, labels, assignees, and viewer', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          c0: {
            __typename: 'Issue',
            number: 148,
            title: 'E3 · Plan review gate',
            url: 'u',
            state: 'OPEN',
            body: 'Ticket body.\n\n## Implementation Plan\n\nPlan text.',
            labels: { nodes: [{ name: 'plan review' }] },
            assignees: { nodes: [{ login: 'alice' }] },
          },
        },
        viewer: { login: 'alice' },
      },
    })
    const result = await fetchGatePreflight({ repo: { owner: 'o', name: 'r' }, number: 148, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBe('alice')
    expect(result.item).toEqual({
      kind: 'issue',
      number: 148,
      title: 'E3 · Plan review gate',
      url: 'u',
      state: 'OPEN',
      body: 'Ticket body.\n\n## Implementation Plan\n\nPlan text.',
      labels: ['plan review'],
      assignees: ['alice'],
    })
  })

  it('resolves a PullRequest node with identity fields only — never body, labels, or assignees', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: { c0: { __typename: 'PullRequest', number: 5, title: 't', url: 'u', state: 'OPEN' } },
        viewer: { login: 'alice' },
      },
    })
    const result = await fetchGatePreflight({ repo: { owner: 'o', name: 'r' }, number: 5, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item).toEqual({ kind: 'pull-request', number: 5, title: 't', url: 'u', state: 'OPEN', body: '', labels: [], assignees: [] })
  })

  it('reports item: null for a number that does not resolve, without failing the fetch', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: { login: 'alice' } } })
    const result = await fetchGatePreflight({ repo: { owner: 'o', name: 'r' }, number: 999999, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item).toBeNull()
    expect(result.viewer).toBe('alice')
    expect(typeof result.fetchedAt).toBe('string')
  })

  it('fails the whole preflight when the viewer login cannot be resolved', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: null } })
    const result = await fetchGatePreflight({ repo: { owner: 'o', name: 'r' }, number: 1, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('no-data')
  })

  it('classifies an HTTP failure through the shared envelope classifier', async () => {
    const result = await fetchGatePreflight({ repo: { owner: 'o', name: 'r' }, number: 1, github: fakeTransport(httpFail('unauthenticated', 401, '', 'GitHub: Bad credentials (HTTP 401)')) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unauthenticated')
    expect(result.message).toBe('GitHub: Bad credentials (HTTP 401)')
    expect(typeof result.fetchedAt).toBe('string')
  })
})

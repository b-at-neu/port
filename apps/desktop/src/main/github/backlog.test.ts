import { describe, expect, it } from 'vitest'
import type { GhResult } from '../platform/gh'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import { fetchBacklog } from './backlog'
import type { GhRunner } from './backlog'

function fakeRunner(result: GhResult): GhRunner {
  return () => Promise.resolve(result)
}

const VOCABULARY = resolveVocabulary({})
const READY_LABEL = VOCABULARY.labels.find((label) => label.key === 'ready')?.name ?? 'ready'

describe('fetchBacklog', () => {
  it('resolves every open issue, dropping any carrying a vocabulary label', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount: 2,
            nodes: [
              { number: 47, title: 'Add dark mode', url: 'u47', updatedAt: '2026-01-01T00:00:00Z', labels: { nodes: [] }, assignees: { nodes: [] } },
              { number: 45, title: 'Already claimed', url: 'u45', updatedAt: '2026-01-02T00:00:00Z', labels: { nodes: [{ name: READY_LABEL }] }, assignees: { nodes: [{ login: 'alice' }] } },
            ],
          },
        },
        viewer: { login: 'octo-dev' },
      },
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([{ number: 47, title: 'Add dark mode', url: 'u47', updatedAt: '2026-01-01T00:00:00Z', assignees: [] }])
    expect(result.scanned).toBe(2)
    expect(result.total).toBe(2)
    expect(result.viewer).toBe('octo-dev')
  })

  it('reports scanned/total divergence as truncation, never as complete', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount: 150,
            nodes: [{ number: 1, title: 't', url: 'u', updatedAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] } }],
          },
        },
        viewer: { login: 'octo-dev' },
      },
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scanned).toBe(1)
    expect(result.total).toBe(150)
  })

  it('leaves viewer null on a viewer-query error, without failing the fetch', async () => {
    const stdout = JSON.stringify({
      data: { repository: { issues: { totalCount: 0, nodes: [] } }, viewer: null },
      errors: [{ path: ['viewer'], message: 'boom' }],
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBeNull()
  })

  it.each([
    ['unauthenticated', { ok: false as const, kind: 'unauthenticated' as const, stdout: '', stderr: 'gh: 401' }],
    ['rate-limited', { ok: false as const, kind: 'rate-limited' as const, stdout: '', stderr: 'rate limited' }],
    ['network', { ok: false as const, kind: 'network' as const, stdout: '', stderr: 'net down' }],
    ['not-found', { ok: false as const, kind: 'not-found' as const, searched: [] }],
    ['forbidden', { ok: false as const, kind: 'forbidden' as const, stdout: '', stderr: 'forbidden' }],
    ['http-not-found', { ok: false as const, kind: 'http-not-found' as const, stdout: '', stderr: '404' }],
  ])('maps a %s gh failure through the shared envelope classifier', async (kind, ghResult) => {
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner(ghResult as GhResult) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe(kind)
  })

  it('maps a repository the envelope reports as absent to repo-not-found', async () => {
    const stdout = JSON.stringify({ data: { repository: null } })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('repo-not-found')
  })

  it('maps any other unclassified failure to unknown', async () => {
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout: 'not json', stderr: '' }) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unparseable')
  })
})

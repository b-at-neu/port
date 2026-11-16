import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import type { TrackedRef } from '@/types/pipeline-state'
import { fetchPipelineItems } from '@/main/github/pipeline'
import { RATE_LIMIT_REPLY, connection } from '../../../fixtures/pipeline-reply'
import { httpOk, queryOf } from '../../../fixtures/github-http'

const REPO = { owner: 'o', name: 'r' }
const VOCABULARY = resolveVocabulary({})
const REPO_LABELS = { totalCount: VOCABULARY.labels.length, nodes: VOCABULARY.labels.map((label) => ({ name: label.name })) }

function ok(body: unknown): GitHubHttpResult {
  return httpOk(JSON.stringify(body))
}

function node(number: number, labels: readonly string[], state = 'OPEN'): Record<string, unknown> {
  return { number, title: `item ${number}`, url: 'u', body: '', state, assignees: { nodes: [] }, labels: { nodes: labels.map((name) => ({ name })) } }
}

const SWEEP_BODY = (issues: readonly unknown[]) => ok({ data: { repository: { repoLabels: REPO_LABELS, issues: connection(issues), pullRequests: connection([]) }, rateLimit: RATE_LIMIT_REPLY } })

interface Script {
  readonly swept: readonly unknown[]
  readonly tracked?: (document: string) => GitHubHttpResult
}

function transport(script: Script): { readonly runner: GitHubTransport; readonly documents: string[] } {
  const documents: string[] = []
  const runner: GitHubTransport = (request) => {
    const document = queryOf(request)
    documents.push(document)
    if (document.includes('integrationHistory:')) return Promise.resolve(ok({ data: { repository: { integrationHistory: null }, rateLimit: RATE_LIMIT_REPLY } }))
    if (document.includes('t0:')) return Promise.resolve((script.tracked ?? (() => ok({ data: { repository: {}, rateLimit: RATE_LIMIT_REPLY } })))(document))
    if (document.includes('d0:')) {
      const repository: Record<string, unknown> = {}
      for (const match of document.matchAll(/d(\d+): issue\(/g)) repository[`d${match[1]}`] = { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } }
      return Promise.resolve(ok({ data: { repository, rateLimit: RATE_LIMIT_REPLY } }))
    }
    return Promise.resolve(SWEEP_BODY(script.swept))
  }
  return { runner, documents }
}

function read(runner: GitHubTransport, tracked: readonly TrackedRef[] | null) {
  return fetchPipelineItems({ repo: REPO, vocabulary: VOCABULARY, integration: 'dev', tracked, github: runner })
}

const TRACKED_PLAN: TrackedRef = { kind: 'issue', number: 3, keys: ['marker', 'planReview'] }

describe('fetchPipelineItems — tracked items', () => {
  it('reads by labels, byte-identical, when tracked is null, and reports nothing closed', async () => {
    const { runner, documents } = transport({ swept: [node(1, ['ready'])] })
    const result = await read(runner, null)
    expect(result.ok && result.items.map((item) => item.number)).toEqual([1])
    expect(result.ok && result.closed).toEqual([])
    expect(documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('drops a swept item the store does not track, and costs no extra read when every tracked item was swept', async () => {
    const { runner, documents } = transport({ swept: [node(1, ['ready']), node(3, ['plan review'])] })
    const result = await read(runner, [TRACKED_PLAN])
    expect(result.ok && result.items.map((item) => item.number)).toEqual([3])
    expect(documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('keeps the store\'s keys on a swept item whose labels disagree', async () => {
    const { runner } = transport({ swept: [node(3, ['ready'])] })
    const result = await read(runner, [TRACKED_PLAN])
    expect(result.ok && result.items[0]?.matchedKeys).toEqual(['marker', 'planReview'])
  })

  it('fetches a tracked item whose labels were all removed, by number, and keeps its stored keys', async () => {
    const { runner, documents } = transport({ swept: [], tracked: () => ok({ data: { repository: { t0: node(3, []) }, rateLimit: RATE_LIMIT_REPLY } }) })
    const result = await read(runner, [TRACKED_PLAN])
    expect(result.ok && result.items).toHaveLength(1)
    expect(result.ok && result.items[0]).toMatchObject({ number: 3, kind: 'issue', matchedKeys: ['marker', 'planReview'] })
    expect(documents.find((document) => document.includes('t0:'))).toContain('t0: issue(number: 3)')
  })

  it('reports a non-open tracked item as closed rather than as an item', async () => {
    const { runner } = transport({ swept: [], tracked: () => ok({ data: { repository: { t0: node(3, ['plan review'], 'CLOSED') }, rateLimit: RATE_LIMIT_REPLY } }) })
    const result = await read(runner, [TRACKED_PLAN])
    expect(result.ok && result.items).toEqual([])
    expect(result.ok && result.closed).toEqual([3])
  })

  it('reports an item GitHub no longer has as closed', async () => {
    const { runner } = transport({
      swept: [],
      tracked: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'NOT_FOUND', path: ['repository', 't0'], message: 'gone' }] }),
    })
    const result = await read(runner, [TRACKED_PLAN])
    expect(result.ok && result.closed).toEqual([3])
  })

  it('fails the whole read when a tracked alias errors for any other reason, never reading it as closed', async () => {
    const { runner } = transport({
      swept: [],
      tracked: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'FORBIDDEN', path: ['repository', 't0'], message: 'no' }] }),
    })
    const result = await read(runner, [TRACKED_PLAN])
    expect(result.ok).toBe(false)
  })
})

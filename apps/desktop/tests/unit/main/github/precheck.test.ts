import { describe, expect, it } from 'vitest'
import { createEtagCache } from '@/main/github/conditional'
import { precheckIssues, precheckRequest } from '@/main/github/precheck'
import type { ConditionalRequest } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { scriptedConditional } from '../../../fixtures/watcher-harness'

const repoId = 'repo-1' as RepoId
const repo = { owner: 'o', name: 'a' }
const now = () => new Date('2026-01-01T00:00:00.000Z')

function setup() {
  const cache = createEtagCache()
  const conditional = scriptedConditional()
  const seen: ConditionalRequest[] = []
  const transport: typeof conditional.transport = (request) => {
    seen.push(request)
    return conditional.transport(request)
  }
  const run = () => precheckIssues({ cache, repoId, repo, conditional: transport, now })
  return { cache, conditional, seen, run }
}

describe('precheckRequest', () => {
  it('asks for the single most recently updated item of either kind, in any state', () => {
    expect(precheckRequest(repo)).toEqual({ method: 'GET', path: 'repos/o/a/issues?state=all&sort=updated&direction=desc&per_page=1' })
  })
})

describe('precheckIssues', () => {
  it('the first 200 only primes the cache', async () => {
    const { run, seen } = setup()
    expect(await run()).toEqual({ ok: true, at: now().toISOString(), changed: false })
    expect(seen[0]?.ifNoneMatch).toBeUndefined()
  })

  it('a 304 against the cached ETag is unchanged', async () => {
    const { run, seen } = setup()
    await run()
    expect(await run()).toMatchObject({ ok: true, changed: false })
    expect(seen[1]?.ifNoneMatch).toBe('"v1"')
  })

  it('a new ETag is a change', async () => {
    const { run, conditional } = setup()
    await run()
    conditional.bump()
    expect(await run()).toMatchObject({ ok: true, changed: true })
    expect(await run()).toMatchObject({ ok: true, changed: false })
  })

  it('forgetting the repo makes the next 200 prime again', async () => {
    const { run, cache, conditional } = setup()
    await run()
    conditional.bump()
    cache.forget(repoId)
    expect(await run()).toMatchObject({ ok: true, changed: false })
  })

  it('a failure reports the reason and keeps the cached ETag', async () => {
    const { run, conditional, seen } = setup()
    await run()
    conditional.fail(true)
    expect(await run()).toEqual({ ok: false, at: now().toISOString(), error: 'GitHub returned HTTP 500' })
    conditional.fail(false)
    await run()
    expect(seen[2]?.ifNoneMatch).toBe('"v1"')
  })
})

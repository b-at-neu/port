import { describe, expect, it } from 'vitest'
import { classifyFailure, collectTruncated, collectUnavailable, parseEnvelope } from './envelope'
import type { AliasInfo } from './envelope'
import type { GhResult } from '../platform/gh'

// Captured live against b-at-neu/port (#76's plan, Decision 3): a
// nonexistent aliased `issue(number: 999999)` beside three intact aliases,
// `gh api graphql` exiting 1 while `data` stays fully usable.
const PARTIAL_ERROR_FIXTURE =
  '{"data":{"repository":{"i0":{"totalCount":0,"nodes":[]},"s0":null,"s1":{"number":76},"repoLabels":{"totalCount":27,"nodes":[{"name":"accessibility"},{"name":"bug"}]}},"rateLimit":{"cost":1,"remaining":4942,"resetAt":"2026-09-05T14:47:43Z"}},"errors":[{"type":"NOT_FOUND","path":["repository","s0"],"locations":[{"line":1,"column":165}],"message":"Could not resolve to an Issue with the number of 999999."}]}'

// Captured live against a nonexistent repository name under the same owner.
const REPO_NOT_FOUND_FIXTURE =
  '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"locations":[{"line":1,"column":3}],"message":"Could not resolve to a Repository with the name \'b-at-neu/zzz-nonexistent-abcxyz\'."}]}'

const okGh = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })
const unknownGh = (stdout: string, stderr = ''): GhResult => ({ ok: false, kind: 'unknown', stdout, stderr })

describe('parseEnvelope', () => {
  it('parses the partial-error fixture', () => {
    const result = parseEnvelope(PARTIAL_ERROR_FIXTURE)
    expect(result.ok).toBe(true)
  })

  it('rejects non-JSON stdout', () => {
    expect(parseEnvelope('not json at all')).toEqual({ ok: false })
  })

  it('rejects a JSON array — not a GraphQL envelope', () => {
    expect(parseEnvelope('[1,2,3]')).toEqual({ ok: false })
  })
})

describe('classifyFailure', () => {
  it('gh binary unresolved is not-found, naming the searched count', () => {
    const verdict = classifyFailure({ ok: false, kind: 'not-found', command: 'gh', searched: ['/a/gh', '/b/gh'] }, undefined)
    expect(verdict).toEqual({ kind: 'not-found', message: "gh isn't on PATH — looked in 2 places" })
  })

  it('a classified exit other than unknown is authoritative, no envelope needed', () => {
    const verdict = classifyFailure({ ok: false, kind: 'unauthenticated', stdout: '', stderr: 'gh: (HTTP 401)' }, undefined)
    expect(verdict).toEqual({ kind: 'unauthenticated', message: 'gh: (HTTP 401)' })
  })

  it('non-JSON stdout on an exit-0 call is unparseable', () => {
    const verdict = classifyFailure(okGh('not json'), parseEnvelope('not json'))
    expect(verdict).toEqual({ kind: 'unparseable', message: "GitHub's reply wasn't JSON" })
  })

  it('RATE_LIMITED in errors overrides a classified unknown', () => {
    const stdout = '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}'
    const verdict = classifyFailure(unknownGh(stdout), parseEnvelope(stdout))
    expect(verdict.kind).toBe('rate-limited')
  })

  it('RATE_LIMITED overrides even when data is present', () => {
    const stdout = '{"data":{"repository":{"id":"x"}},"errors":[{"type":"RATE_LIMITED"}]}'
    const verdict = classifyFailure(okGh(stdout), parseEnvelope(stdout))
    expect(verdict.kind).toBe('rate-limited')
  })

  it('absent data is no-data — a blind fetch, never read as empty', () => {
    const stdout = '{"errors":[{"message":"something went sideways"}]}'
    const verdict = classifyFailure(unknownGh(stdout), parseEnvelope(stdout))
    expect(verdict.kind).toBe('no-data')
  })

  it('data.repository null is repo-not-found (live fixture)', () => {
    const verdict = classifyFailure(unknownGh(REPO_NOT_FOUND_FIXTURE), parseEnvelope(REPO_NOT_FOUND_FIXTURE))
    expect(verdict.kind).toBe('repo-not-found')
  })

  it('a partial response (errors present, data usable) classifies as ok', () => {
    const verdict = classifyFailure(unknownGh(PARTIAL_ERROR_FIXTURE), parseEnvelope(PARTIAL_ERROR_FIXTURE))
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('a full success with no errors classifies as ok', () => {
    const stdout = '{"data":{"repository":{"i0":{"totalCount":0,"nodes":[]}}}}'
    const verdict = classifyFailure(okGh(stdout), parseEnvelope(stdout))
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('no failure path produces the ok verdict alongside an empty-looking envelope claim', () => {
    // Every branch other than the final 'ok' returns a distinct kind, never
    // silently reusing 'ok' — enumerate every failure kind this function can
    // return and confirm none of them is the string 'ok'.
    const cases: FailureCase[] = [
      [{ ok: false, kind: 'cwd-missing', cwd: '/nope' }, undefined],
      [{ ok: false, kind: 'signalled', signal: 'SIGKILL', stderr: '' }, undefined],
      [{ ok: false, kind: 'timeout', timeoutMs: 30_000, stderr: '' }, undefined],
      [{ ok: false, kind: 'output-too-large', maxBytes: 1024 }, undefined],
      [{ ok: false, kind: 'spawn-failed', message: 'ENOMEM' }, undefined],
      [{ ok: false, kind: 'forbidden', stdout: '', stderr: '(HTTP 403)' }, undefined],
      [{ ok: false, kind: 'http-not-found', stdout: '', stderr: '(HTTP 404)' }, undefined],
      [{ ok: false, kind: 'network', stdout: '', stderr: 'ENOTFOUND' }, undefined],
    ]
    for (const [ghResult, envelope] of cases) {
      const verdict = classifyFailure(ghResult, envelope)
      expect(verdict.kind).not.toBe('ok')
    }
  })
})

type FailureCase = readonly [GhResult, ReturnType<typeof parseEnvelope> | undefined]

describe('collectUnavailable', () => {
  const aliasIndex = new Map<string, AliasInfo>([['s0', { key: 'ready', name: 'ready', surface: 'issue' }]])

  it('maps errors[].path to the alias table, deduplicated', () => {
    const parsed = parseEnvelope(PARTIAL_ERROR_FIXTURE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const unavailable = collectUnavailable(parsed.value.errors, aliasIndex)
    expect(unavailable).toEqual([{ alias: 's0', key: 'ready', surface: 'issue', name: 'ready' }])
  })

  it('ignores an error whose path does not name a known alias', () => {
    const unavailable = collectUnavailable([{ path: ['repository', 'unknownAlias'] }], aliasIndex)
    expect(unavailable).toEqual([])
  })

  it('returns an empty list with no errors', () => {
    expect(collectUnavailable(undefined, aliasIndex)).toEqual([])
  })
})

describe('collectTruncated', () => {
  const aliasIndex = new Map<string, AliasInfo>([['i0', { key: 'ready', name: 'ready', surface: 'issue' }]])

  it('reports a connection whose totalCount exceeds its nodes length', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ number: i }))
    const repository = { i0: { totalCount: 150, nodes } }
    expect(collectTruncated(repository, aliasIndex)).toEqual([{ alias: 'i0', key: 'ready', surface: 'issue', totalCount: 150, received: 100 }])
  })

  it('reports nothing when totalCount matches nodes length', () => {
    const repository = { i0: { totalCount: 2, nodes: [{}, {}] } }
    expect(collectTruncated(repository, aliasIndex)).toEqual([])
  })
})

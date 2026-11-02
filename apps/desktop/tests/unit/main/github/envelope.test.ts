import { describe, expect, it } from 'vitest'
import { bodyOf, classifyFailure, collectUnavailable, describeHttp, parseEnvelope } from '@/main/github/envelope'
import type { AliasInfo, SweepAlias } from '@/types/github'
import type { GitHubHttpResult } from '@/types/platform'
import { httpFail, httpOk } from '../../../fixtures/github-http'

// Captured live: a nonexistent aliased issue(number: 999999) beside three intact aliases, GitHub
// answering 200 with `errors` while data stays fully usable.
const PARTIAL_ERROR_FIXTURE =
  '{"data":{"repository":{"i0":{"totalCount":0,"nodes":[]},"s0":null,"s1":{"number":76},"repoLabels":{"totalCount":27,"nodes":[{"name":"accessibility"},{"name":"bug"}]}},"rateLimit":{"cost":1,"remaining":4942,"resetAt":"2026-09-05T14:47:43Z"}},"errors":[{"type":"NOT_FOUND","path":["repository","s0"],"locations":[{"line":1,"column":165}],"message":"Could not resolve to an Issue with the number of 999999."}]}'

// Captured live against a nonexistent repository name under the same owner.
const REPO_NOT_FOUND_FIXTURE =
  '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"locations":[{"line":1,"column":3}],"message":"Could not resolve to a Repository with the name \'b-at-neu/zzz-nonexistent-abcxyz\'."}]}'

const okGh = (body: string): GitHubHttpResult => httpOk(body)
const unknownGh = (body: string): GitHubHttpResult => httpFail('unknown', 422, body)

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
    const verdict = classifyFailure(httpFail('unauthenticated', 401, '', 'GitHub: Bad credentials (HTTP 401)'), undefined)
    expect(verdict).toEqual({ kind: 'unauthenticated', message: 'GitHub: Bad credentials (HTTP 401)' })
  })

  it('an unknown status such as a 422 falls through to the envelope, and a usable body stays ok', () => {
    const body = '{"data":{"repository":{"i0":{"totalCount":0,"nodes":[]}}}}'
    expect(classifyFailure(unknownGh(body), parseEnvelope(body))).toEqual({ kind: 'ok' })
  })

  it('an unknown status with an unparseable body carries its own message', () => {
    const verdict = classifyFailure(httpFail('unknown', 400, 'nope', 'GitHub: HTTP 400'), parseEnvelope('nope'))
    expect(verdict).toEqual({ kind: 'unknown', message: 'GitHub: HTTP 400' })
  })

  it('a timeout and an oversized body use GitHub-worded messages', () => {
    expect(classifyFailure({ ok: false, kind: 'timeout', timeoutMs: 30_000, stderr: '' }, undefined)).toEqual({ kind: 'timeout', message: "GitHub didn't reply within 30000ms" })
    expect(classifyFailure({ ok: false, kind: 'output-too-large', maxBytes: 1024 }, undefined)).toEqual({ kind: 'output-too-large', message: "GitHub's reply exceeded 1024 bytes" })
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
    // Every branch other than the final 'ok' returns a distinct kind, never silently reusing 'ok'.
    const cases: FailureCase[] = [
      [{ ok: false, kind: 'cwd-missing', cwd: '/nope' }, undefined],
      [{ ok: false, kind: 'signalled', signal: 'SIGKILL', stderr: '' }, undefined],
      [{ ok: false, kind: 'timeout', timeoutMs: 30_000, stderr: '' }, undefined],
      [{ ok: false, kind: 'output-too-large', maxBytes: 1024 }, undefined],
      [{ ok: false, kind: 'spawn-failed', message: 'ENOMEM' }, undefined],
      [httpFail('forbidden', 403), undefined],
      [httpFail('http-not-found', 404), undefined],
      [httpFail('network', 502), undefined],
      [{ ok: false, kind: 'network', status: null, body: '', message: 'GitHub is unreachable: ENOTFOUND' }, undefined],
    ]
    for (const [ghResult, envelope] of cases) {
      const verdict = classifyFailure(ghResult, envelope)
      expect(verdict.kind).not.toBe('ok')
    }
  })
})

type FailureCase = readonly [GitHubHttpResult, ReturnType<typeof parseEnvelope> | undefined]

describe('bodyOf / describeHttp', () => {
  it('bodyOf keeps the body of a success and of a classified failure, and has none for a transport failure', () => {
    expect(bodyOf(httpOk('{}'))).toBe('{}')
    expect(bodyOf(httpFail('unknown', 422, 'text'))).toBe('text')
    expect(bodyOf({ ok: false, kind: 'timeout', timeoutMs: 1, stderr: '' })).toBeUndefined()
  })

  it('describeHttp prefers the failure message and names a missing gh', () => {
    expect(describeHttp(httpFail('forbidden', 403, '', 'GitHub: Resource not accessible (HTTP 403)'))).toBe('GitHub: Resource not accessible (HTTP 403)')
    expect(describeHttp({ ok: false, kind: 'not-found', command: 'gh', searched: [] })).toBe("gh isn't on PATH")
    expect(describeHttp({ ok: false, kind: 'spawn-failed', message: 'ENOMEM' })).toBe('ENOMEM')
    expect(describeHttp({ ok: false, kind: 'signalled', signal: 'SIGKILL', stderr: '' })).toBe('signalled')
  })
})

describe('collectUnavailable', () => {
  const aliasIndex = new Map<SweepAlias, AliasInfo>([
    ['issues', { surface: 'issue' }],
    ['pullRequests', { surface: 'pull-request' }],
  ])

  it('maps errors[].path to the surface, deduplicated', () => {
    const errors = [{ path: ['repository', 'pullRequests'] }, { path: ['repository', 'pullRequests', 'nodes', 0] }, { path: ['repository', 'issues'] }]
    expect(collectUnavailable(errors, aliasIndex)).toEqual([
      { alias: 'pullRequests', surface: 'pull-request' },
      { alias: 'issues', surface: 'issue' },
    ])
  })

  it('ignores an error whose path does not name a sweep connection', () => {
    expect(collectUnavailable([{ path: ['repository', 'unknownAlias'] }, { path: ['viewer'] }], aliasIndex)).toEqual([])
  })

  it('reads the captured partial-error fixture as no sweep connection unavailable', () => {
    const parsed = parseEnvelope(PARTIAL_ERROR_FIXTURE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(collectUnavailable(parsed.value.errors, aliasIndex)).toEqual([])
  })

  it('returns an empty list with no errors', () => {
    expect(collectUnavailable(undefined, aliasIndex)).toEqual([])
  })
})

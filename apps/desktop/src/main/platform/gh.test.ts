import { describe, expect, it } from 'vitest'
import { classifyGhExit, gh, ghAuthStatus, ghJson } from './gh'

describe('classifyGhExit — pure classifier, no gh spawned', () => {
  it('exit code 4 is unauthenticated, ahead of any string match', () => {
    expect(classifyGhExit({ code: 4, stdout: '', stderr: 'irrelevant (HTTP 500)' })).toBe('unauthenticated')
  })

  it('(HTTP 401) is unauthenticated', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'error: (HTTP 401)' })).toBe('unauthenticated')
  })

  it('(HTTP 403) with rate-limit wording is rate-limited', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'API rate limit exceeded (HTTP 403)' })).toBe('rate-limited')
  })

  it('(HTTP 403) without rate-limit wording is forbidden', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'Resource not accessible (HTTP 403)' })).toBe('forbidden')
  })

  it('(HTTP 429) is rate-limited', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'too many requests (HTTP 429)' })).toBe('rate-limited')
  })

  it('(HTTP 404) is http-not-found', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'Not Found (HTTP 404)' })).toBe('http-not-found')
  })

  it('(HTTP 502) is network', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'Bad Gateway (HTTP 502)' })).toBe('network')
  })

  it('a DNS failure is network', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com: no such host' })).toBe('network')
  })

  it('an unrecognised stderr lands on unknown, with stderr preserved by the caller', () => {
    expect(classifyGhExit({ code: 1, stdout: '', stderr: 'something entirely unexpected' })).toBe('unknown')
  })
})

describe('gh — classified failure preserves stdout', () => {
  it('a non-zero exit carries both stdout and stderr (#76: gh api graphql exits non-zero with data still in stdout)', async () => {
    const result = await gh(['api', 'graphql'], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/gh' }),
      spawner: () =>
        Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stdout: '{"data":{},"errors":[{}]}', stderr: 'gh: some errors' })),
    })
    expect(result).toEqual({ ok: false, kind: 'unknown', stdout: '{"data":{},"errors":[{}]}', stderr: 'gh: some errors' })
  })
})

describe('ghJson', () => {
  it('returns unparseable with the raw stdout on malformed JSON, never null', async () => {
    const result = await ghJson(['api', 'repos/x/y'], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/gh' }),
      spawner: () => Promise.resolve({ stdout: 'not json', stderr: '' }),
    })
    expect(result).toEqual({ ok: false, kind: 'unparseable', stdout: 'not json' })
  })

  it('parses valid JSON', async () => {
    const result = await ghJson<{ ok: boolean }>(['api', 'repos/x/y'], {
      resolve: () => Promise.resolve({ ok: true, path: '/usr/bin/gh' }),
      spawner: () => Promise.resolve({ stdout: '{"ok":true}', stderr: '' }),
    })
    expect(result).toEqual({ ok: true, data: { ok: true } })
  })
})

describe('ghAuthStatus — integration', () => {
  it('reads only the exit code, distinguishing authenticated from unauthenticated', async (ctx) => {
    const result = await ghAuthStatus()
    if (!result.ok && result.kind === 'not-found') {
      ctx.skip()
      return
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(typeof result.authenticated).toBe('boolean')
    }
  }, 15_000)
})

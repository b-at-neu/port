import { describe, expect, it } from 'vitest'
import type { GitHubHttpResult } from '@/types/platform'
import { readAllowBase } from '@/main/github/allow'
import { githubCtx, httpFail, httpOk, recordingTransport } from '../../../fixtures/github-http'

const OK = (body: string): GitHubHttpResult => httpOk(body)
const NOT_FOUND = httpFail('http-not-found', 404, '{"message":"Not Found"}', 'GitHub: Not Found (HTTP 404)')
const FAIL = httpFail('unknown', 400, '', 'GitHub: boom (HTTP 400)')

const HEAD = OK(JSON.stringify({ sha: 'head-oid', commit: { tree: { sha: 'tree-oid' } } }))
const PARAMS = { repo: { owner: 'acme', name: 'widgets' }, integration: 'dev', branch: 'allow/x-1234abcd' }
const PULL = '[{"number":9,"url":"https://api.github.com/repos/acme/widgets/pulls/9","html_url":"https://github.com/acme/widgets/pull/9"}]'

function read(responses: readonly GitHubHttpResult[], params = PARAMS) {
  const { transport, requests } = recordingTransport((_request, index) => responses[index] ?? OK(''))
  return readAllowBase(githubCtx(transport), params).then((result) => ({ result, requests }))
}

describe('readAllowBase', () => {
  it('reads both files at the head oid, never the branch name', async () => {
    const { result, requests } = await read([HEAD, OK('{"config":1}'), OK('{"settings":1}'), OK('[]')])
    expect(result).toEqual({ ok: true, head: { oid: 'head-oid', tree: 'tree-oid' }, settingsText: '{"settings":1}', configText: '{"config":1}', openPr: null })
    expect(requests.map((request) => request.path)).toEqual([
      'repos/acme/widgets/commits/dev',
      'repos/acme/widgets/contents/.claude/port.config.json?ref=head-oid',
      'repos/acme/widgets/contents/.claude/settings.json?ref=head-oid',
      'repos/acme/widgets/pulls?head=acme%3Aallow%2Fx-1234abcd&base=dev&state=open&per_page=1',
    ])
  })

  const outcomes: readonly { readonly name: string; readonly responses: readonly GitHubHttpResult[]; readonly expected: object }[] = [
    { name: 'a 404 on settings.json reads as null', responses: [HEAD, OK('{}'), NOT_FOUND, OK('[]')], expected: { ok: true, settingsText: null } },
    { name: 'an open pull request on the branch is returned by its web url', responses: [HEAD, OK('{}'), OK('{}'), OK(PULL)], expected: { ok: true, openPr: { number: 9, url: 'https://github.com/acme/widgets/pull/9' } } },
    { name: 'an unreadable port.config.json fails the read, even as a 404', responses: [HEAD, NOT_FOUND], expected: { ok: false } },
    { name: 'a settings.json error that is not a 404 fails the read', responses: [HEAD, OK('{}'), FAIL], expected: { ok: false } },
    { name: 'a failed head read fails the read', responses: [FAIL], expected: { ok: false } },
    { name: 'a failed pull request list fails the read', responses: [HEAD, OK('{}'), OK('{}'), FAIL], expected: { ok: false } },
  ]
  it.each(outcomes)('$name', async ({ responses, expected }) => {
    expect((await read(responses)).result).toMatchObject(expected)
  })

  it('refuses an integration name outside the safe pattern without a request', async () => {
    const { result, requests } = await read([], { ...PARAMS, integration: 'dev;rm' })
    expect(result.ok).toBe(false)
    expect(requests).toEqual([])
  })
})

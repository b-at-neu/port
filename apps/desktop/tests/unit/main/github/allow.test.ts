import { describe, expect, it } from 'vitest'
import type { GitHubHttpResult, GitHubRequest, GitHubTransport } from '@/types/platform'
import { readAllowBase } from '@/main/github/allow'
import { httpFail, httpOk } from '../../../fixtures/github-http'

const OK = (body: string): GitHubHttpResult => httpOk(body)
const NOT_FOUND = httpFail('http-not-found', 404, '{"message":"Not Found"}', 'GitHub: Not Found (HTTP 404)')
const FAIL = httpFail('unknown', 400, '', 'GitHub: boom (HTTP 400)')

const HEAD = OK(JSON.stringify({ sha: 'head-oid', commit: { tree: { sha: 'tree-oid' } } }))
const PARAMS = { repo: { owner: 'acme', name: 'widgets' }, integration: 'dev', branch: 'allow/x-1234abcd' }

function runner(responses: readonly GitHubHttpResult[]): { readonly github: GitHubTransport; readonly calls: GitHubRequest[] } {
  const calls: GitHubRequest[] = []
  let index = 0
  return {
    calls,
    github: (request) => {
      calls.push(request)
      return Promise.resolve(responses[index++] ?? OK(''))
    },
  }
}

describe('readAllowBase', () => {
  it('reads both files at the head oid and reports no open pull request', async () => {
    const { github, calls } = runner([HEAD, OK('{"config":1}'), OK('{"settings":1}'), OK('[]')])
    const read = await readAllowBase({ ...PARAMS, github })
    expect(read).toEqual({ ok: true, head: { oid: 'head-oid', tree: 'tree-oid' }, settingsText: '{"settings":1}', configText: '{"config":1}', openPr: null })
    expect(calls[0]).toEqual({ method: 'GET', path: 'repos/acme/widgets/commits/dev' })
    expect(calls[1]).toEqual({ method: 'GET', path: 'repos/acme/widgets/contents/.claude/port.config.json?ref=head-oid', accept: 'application/vnd.github.raw' })
    expect(calls[2]).toEqual({ method: 'GET', path: 'repos/acme/widgets/contents/.claude/settings.json?ref=head-oid', accept: 'application/vnd.github.raw' })
    expect(calls[3]).toEqual({ method: 'GET', path: 'repos/acme/widgets/pulls?head=acme%3Aallow%2Fx-1234abcd&base=dev&state=open&per_page=1' })
  })

  it('reads a 404 on settings.json as null', async () => {
    const { github } = runner([HEAD, OK('{}'), NOT_FOUND, OK('[]')])
    const read = await readAllowBase({ ...PARAMS, github })
    expect(read.ok && read.settingsText).toBeNull()
  })

  it('returns an open pull request on the branch, by its web url', async () => {
    const pull = '[{"number":9,"url":"https://api.github.com/repos/acme/widgets/pulls/9","html_url":"https://github.com/acme/widgets/pull/9"}]'
    const { github } = runner([HEAD, OK('{}'), OK('{}'), OK(pull)])
    const read = await readAllowBase({ ...PARAMS, github })
    expect(read.ok && read.openPr).toEqual({ number: 9, url: 'https://github.com/acme/widgets/pull/9' })
  })

  it('fails the whole read when port.config.json is unreadable, even as a 404', async () => {
    expect((await readAllowBase({ ...PARAMS, github: runner([HEAD, NOT_FOUND]).github })).ok).toBe(false)
  })

  it('fails on a settings.json error that is not a 404, and on a failed head or list read', async () => {
    expect((await readAllowBase({ ...PARAMS, github: runner([HEAD, OK('{}'), FAIL]).github })).ok).toBe(false)
    expect((await readAllowBase({ ...PARAMS, github: runner([FAIL]).github })).ok).toBe(false)
    expect((await readAllowBase({ ...PARAMS, github: runner([HEAD, OK('{}'), OK('{}'), FAIL]).github })).ok).toBe(false)
  })

  it('refuses an integration name outside the safe pattern without a request', async () => {
    const { github, calls } = runner([])
    expect((await readAllowBase({ ...PARAMS, integration: 'dev;rm', github })).ok).toBe(false)
    expect(calls).toEqual([])
  })
})

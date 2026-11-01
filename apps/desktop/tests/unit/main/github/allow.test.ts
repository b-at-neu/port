import { describe, expect, it } from 'vitest'
import type { GhResult, GhRunner } from '@/types/platform'
import { readAllowBase } from '@/main/github/allow'

const OK = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })
const NOT_FOUND: GhResult = { ok: false, kind: 'http-not-found', stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
const FAIL: GhResult = { ok: false, kind: 'unknown', stdout: '', stderr: 'boom' }

const HEAD = OK(JSON.stringify({ sha: 'head-oid', commit: { tree: { sha: 'tree-oid' } } }))
const PARAMS = { repo: { owner: 'acme', name: 'widgets' }, integration: 'dev', branch: 'allow/x-1234abcd' }

function runner(responses: readonly GhResult[]): { readonly gh: GhRunner; readonly calls: string[][] } {
  const calls: string[][] = []
  let index = 0
  return {
    calls,
    gh: (args) => {
      calls.push([...args])
      return Promise.resolve(responses[index++] ?? OK(''))
    },
  }
}

describe('readAllowBase', () => {
  it('reads both files at the head oid and reports no open pull request', async () => {
    const { gh, calls } = runner([HEAD, OK('{"config":1}'), OK('{"settings":1}'), OK('[]')])
    const read = await readAllowBase({ ...PARAMS, gh })
    expect(read).toEqual({ ok: true, head: { oid: 'head-oid', tree: 'tree-oid' }, settingsText: '{"settings":1}', configText: '{"config":1}', openPr: null })
    expect(calls[0]).toEqual(['api', 'repos/acme/widgets/commits/dev'])
    expect(calls[1]?.[1]).toBe('repos/acme/widgets/contents/.claude/port.config.json?ref=head-oid')
    expect(calls[2]?.[1]).toBe('repos/acme/widgets/contents/.claude/settings.json?ref=head-oid')
    expect(calls[3]).toEqual(['pr', 'list', '--repo', 'acme/widgets', '--head', 'allow/x-1234abcd', '--base', 'dev', '--state', 'open', '--json', 'number,url'])
  })

  it('reads a 404 on settings.json as null', async () => {
    const { gh } = runner([HEAD, OK('{}'), NOT_FOUND, OK('[]')])
    const read = await readAllowBase({ ...PARAMS, gh })
    expect(read.ok && read.settingsText).toBeNull()
  })

  it('returns an open pull request on the branch', async () => {
    const { gh } = runner([HEAD, OK('{}'), OK('{}'), OK('[{"number":9,"url":"https://github.com/acme/widgets/pull/9"}]')])
    const read = await readAllowBase({ ...PARAMS, gh })
    expect(read.ok && read.openPr).toEqual({ number: 9, url: 'https://github.com/acme/widgets/pull/9' })
  })

  it('fails the whole read when port.config.json is unreadable, even as a 404', async () => {
    expect((await readAllowBase({ ...PARAMS, gh: runner([HEAD, NOT_FOUND]).gh })).ok).toBe(false)
  })

  it('fails on a settings.json error that is not a 404, and on a failed head or list read', async () => {
    expect((await readAllowBase({ ...PARAMS, gh: runner([HEAD, OK('{}'), FAIL]).gh })).ok).toBe(false)
    expect((await readAllowBase({ ...PARAMS, gh: runner([FAIL]).gh })).ok).toBe(false)
    expect((await readAllowBase({ ...PARAMS, gh: runner([HEAD, OK('{}'), OK('{}'), FAIL]).gh })).ok).toBe(false)
  })

  it('refuses an integration name outside the safe pattern without calling gh', async () => {
    const { gh, calls } = runner([])
    expect((await readAllowBase({ ...PARAMS, integration: 'dev;rm', gh })).ok).toBe(false)
    expect(calls).toEqual([])
  })
})

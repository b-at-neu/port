import { describe, expect, it } from 'vitest'
import { setupModel } from './model'
import type { QueryState } from './model'
import type { RuntimePreflight, RuntimeProbe } from '../../../shared/runtime/types'
import type { GhStatus } from '../../../shared/gh/types'
import type { ReposListResponse } from '../../../shared/ipc'

function preflight(overrides: Partial<RuntimePreflight> = {}): QueryState<RuntimePreflight> {
  return {
    status: 'success',
    data: { checkedAt: 'now', executable: null, version: null, credentials: null, apiKeyInEnvironment: false, diagnosis: 'unverified', detail: null, ...overrides },
  }
}

function gh(kind: GhStatus['kind'], message = 'boom'): QueryState<GhStatus> {
  const data: GhStatus = kind === 'unknown' ? { kind, message, checkedAt: 'now' } : { kind, checkedAt: 'now' }
  return { status: 'success', data }
}

function repos(repositories: ReposListResponse): QueryState<ReposListResponse> {
  return { status: 'success', data: repositories }
}

const LOADING = { status: 'pending' as const }
const NO_REPOS = repos({ ok: true, repositories: [] })
const ONE_REPO = repos({
  ok: true,
  repositories: [
    {
      id: 'repo-1' as never,
      path: '/repo',
      displayName: 'widgets',
      status: 'ready',
      config: { repo: 'acme/widgets' } as never,
      diagnostics: [],
    },
  ],
})

describe('setupModel', () => {
  it('every step loading leaves complete false', () => {
    const model = setupModel(LOADING, null, LOADING, LOADING)
    expect(model.claude.state).toBe('loading')
    expect(model.gh.state).toBe('loading')
    expect(model.repo.state).toBe('loading')
    expect(model.complete).toBe(false)
  })

  it('complete only when every step is done', () => {
    const model = setupModel(preflight({ diagnosis: 'unverified' }), null, gh('signed-in'), ONE_REPO)
    expect(model.claude.state).toBe('done')
    expect(model.gh.state).toBe('done')
    expect(model.repo.state).toBe('done')
    expect(model.complete).toBe(true)
  })

  it('an unverified preflight with no probe counts claude as done', () => {
    const model = setupModel(preflight({ diagnosis: 'unverified' }), null, gh('signed-in'), ONE_REPO)
    expect(model.claude.state).toBe('done')
    expect(model.claude.action).toEqual({ label: 'Test sign-in', kind: 'test' })
  })

  it('a verified probe counts claude as done, with no action', () => {
    const probe: RuntimeProbe = { checkedAt: 'now', repo: 'acme/widgets', elapsedMs: 1200, apiKeyInEnvironment: false, diagnosis: 'verified', detail: null }
    const model = setupModel(preflight({ diagnosis: 'unverified' }), probe, gh('signed-in'), ONE_REPO)
    expect(model.claude.state).toBe('done')
    expect(model.claude.body).toBe('Signed in · verified in 1.2s')
    expect(model.claude.action).toBeNull()
    expect(model.complete).toBe(true)
  })

  it('a null-repo probe still counts claude as done (repository-free Test sign-in)', () => {
    const probe: RuntimeProbe = { checkedAt: 'now', repo: null, elapsedMs: 800, apiKeyInEnvironment: false, diagnosis: 'verified', detail: null }
    const model = setupModel(preflight({ diagnosis: 'unverified' }), probe, gh('signed-in'), NO_REPOS)
    expect(model.claude.state).toBe('done')
  })

  it('any failure diagnosis fails the claude step and complete', () => {
    const model = setupModel(preflight({ diagnosis: 'cli-missing' }), null, gh('signed-in'), ONE_REPO)
    expect(model.claude.state).toBe('failed')
    expect(model.claude.action).toEqual({ label: 'Check again', kind: 'check-again' })
    expect(model.complete).toBe(false)
  })

  it('a probe failure overrides an unverified preflight', () => {
    const probe: RuntimeProbe = { checkedAt: 'now', repo: 'acme/widgets', elapsedMs: 100, apiKeyInEnvironment: false, diagnosis: 'unauthenticated', detail: 'not logged in' }
    const model = setupModel(preflight({ diagnosis: 'unverified' }), probe, gh('signed-in'), ONE_REPO)
    expect(model.claude.state).toBe('failed')
    expect(model.claude.detail).toBe('not logged in')
  })

  it('surfaces the API key note only when the probe reports one', () => {
    const probe: RuntimeProbe = { checkedAt: 'now', repo: null, elapsedMs: 100, apiKeyInEnvironment: true, diagnosis: 'verified', detail: null }
    const model = setupModel(preflight(), probe, gh('signed-in'), ONE_REPO)
    expect(model.claudeApiKeyNote).not.toBeNull()
  })

  it('a preflight query error is never done, and never complete', () => {
    const model = setupModel({ status: 'error' }, null, gh('signed-in'), ONE_REPO)
    expect(model.claude.state).toBe('unreachable')
    expect(model.complete).toBe(false)
  })

  it('gh missing and signed-out both need the operator', () => {
    expect(setupModel(preflight(), null, gh('missing'), ONE_REPO).gh.state).toBe('needs-you')
    expect(setupModel(preflight(), null, gh('signed-out'), ONE_REPO).gh.state).toBe('needs-you')
  })

  it('gh unknown is unreachable, carrying the message as detail', () => {
    const model = setupModel(preflight(), null, gh('unknown', 'auth status failed'), ONE_REPO)
    expect(model.gh.state).toBe('unreachable')
    expect(model.gh.detail).toBe('auth status failed')
  })

  it('no repositories registered needs the operator, with an Add repository action', () => {
    const model = setupModel(preflight(), null, gh('signed-in'), NO_REPOS)
    expect(model.repo.state).toBe('needs-you')
    expect(model.repo.action).toEqual({ label: 'Add repository', kind: 'add-repository' })
  })

  it('a registered repository, any status, counts the repo step done', () => {
    const notReady = repos({
      ok: true,
      repositories: [{ id: 'repo-1' as never, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' }, diagnostics: [] }],
    })
    expect(setupModel(preflight(), null, gh('signed-in'), notReady).repo.state).toBe('done')
  })

  it('a registry read failure is never done', () => {
    const failed = repos({ ok: false, kind: 'registry-unreadable', message: 'boom' })
    const model = setupModel(preflight(), null, gh('signed-in'), failed)
    expect(model.repo.state).toBe('unreachable')
    expect(model.complete).toBe(false)
  })

  it('more than one repository summarizes as "and N more"', () => {
    const many = repos({
      ok: true,
      repositories: [
        { id: 'a' as never, path: '/a', displayName: 'a', status: 'ready', config: { repo: 'acme/widgets' } as never, diagnostics: [] },
        { id: 'b' as never, path: '/b', displayName: 'b', status: 'ready', config: { repo: 'acme/gadgets' } as never, diagnostics: [] },
        { id: 'c' as never, path: '/c', displayName: 'c', status: 'ready', config: { repo: 'acme/gizmos' } as never, diagnostics: [] },
      ],
    })
    expect(setupModel(preflight(), null, gh('signed-in'), many).repo.body).toBe('acme/widgets and 2 more')
  })
})

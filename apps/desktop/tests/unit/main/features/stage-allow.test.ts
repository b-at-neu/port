import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { AllowBaseRead, StageDenial } from '@/types/stage'
import { readAllowBase } from '@/main/github/allow'
import { proposeAllowRule } from '@/main/github/writes/allow'
import { callAction, createTestContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'

vi.mock('@/main/github/allow', () => ({ readAllowBase: vi.fn() }))
vi.mock('@/main/github/writes/allow', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/main/github/writes/allow')>()), proposeAllowRule: vi.fn() }))

const REPO_ID = 'repo-1' as unknown as RepoId
const READY_ENTRY = readyEntry({ id: REPO_ID, path: '/repo' }, { repo: 'acme/widgets', owner: 'acme', name: 'widgets' })

const DENIAL: StageDenial = { id: 'd1', repoId: REPO_ID, agent: 'plan', number: 480, toolName: 'Bash', inputSummary: 'pnpm test', rule: 'Bash(pnpm *)', at: '2026-01-01T00:00:00.000Z', sessionKey: null }
const HEAD = { oid: 'head', tree: 'tree' }
const CONFIG_TEXT = JSON.stringify({ extraAllow: [] })
const SETTINGS_TEXT = JSON.stringify({ permissions: { allow: [] } })

function base(overrides: Partial<Extract<AllowBaseRead, { ok: true }>> = {}): AllowBaseRead {
  return { ok: true, head: HEAD, settingsText: SETTINGS_TEXT, configText: CONFIG_TEXT, openPr: null, ...overrides }
}

const read = vi.mocked(readAllowBase)
const propose = vi.mocked(proposeAllowRule)

function setup(given: AllowBaseRead, proposed: Awaited<ReturnType<typeof proposeAllowRule>> = { ok: true, number: 7, url: 'https://github.com/acme/widgets/pull/7' }) {
  read.mockResolvedValue(given)
  propose.mockResolvedValue(proposed)
  const clearDenialsFor = vi.fn()
  const ctx = createTestContext({
    repositories: [READY_ENTRY],
    live: { dispatcher: { status: () => [{ repoId: REPO_ID, denials: [DENIAL] }], clearDenialsFor, dismissDenial: vi.fn() } as never },
  })
  return { ctx, clear: clearDenialsFor }
}

const request = { repoId: REPO_ID, denialId: 'd1', rule: 'Bash(pnpm *)' }

describe('stage.allow', () => {
  beforeEach(() => {
    read.mockReset()
    propose.mockReset()
  })

  it('proposes a pull request and clears the rule from the denials', async () => {
    const { ctx, clear } = setup(base())
    expect(await callAction(ctx, 'stage.allow', request)).toEqual({ kind: 'proposed', number: 7, url: 'https://github.com/acme/widgets/pull/7' })
    expect(read.mock.calls[0]?.[1]).toMatchObject({ repo: { owner: 'acme', name: 'widgets' }, integration: 'dev' })
    expect(propose.mock.calls[0]?.[2]).toMatchObject({ head: HEAD, rule: 'Bash(pnpm *)', integration: 'dev' })
    expect(propose.mock.calls[0]?.[2].files.map((f) => f.path)).toEqual(['.claude/settings.json', '.claude/port.config.json'])
    expect(propose.mock.calls[0]?.[1]).toMatchObject({ repo: 'acme/widgets', repoId: REPO_ID, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp })
    expect(clear).toHaveBeenCalledWith(REPO_ID, 'Bash(pnpm *)')
  })

  it('reports already-proposed from an open pull request without writing', async () => {
    const { ctx, clear } = setup(base({ openPr: { number: 5, url: 'u' } }))
    expect(await callAction(ctx, 'stage.allow', request)).toEqual({ kind: 'already-proposed', number: 5, url: 'u' })
    expect(propose).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
  })

  it('reports already-allowed on integration and clears the stale denial', async () => {
    const { ctx, clear } = setup(base({ settingsText: JSON.stringify({ permissions: { allow: ['Bash(pnpm *)'] } }), configText: JSON.stringify({ extraAllow: ['Bash(pnpm *)'] }) }))
    expect(await callAction(ctx, 'stage.allow', request)).toEqual({ kind: 'already-allowed', integration: 'dev' })
    expect(propose).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
  })

  it('refuses an invalid rule before any read, keeping the denial', async () => {
    const { ctx, clear } = setup(base())
    expect(await callAction(ctx, 'stage.allow', { ...request, rule: 'Bash' })).toEqual({ kind: 'invalid-rule', reason: 'unrestricted' })
    expect(read).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('fails the read step and keeps the denial', async () => {
    const { ctx, clear } = setup({ ok: false, message: 'rate limited' })
    expect(await callAction(ctx, 'stage.allow', request)).toEqual({ kind: 'failed', step: 'read', message: 'rate limited' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('fails the read step when a file on integration is not JSON', async () => {
    const { ctx } = setup(base({ configText: '{' }))
    expect(await callAction(ctx, 'stage.allow', request)).toMatchObject({ kind: 'failed', step: 'read' })
  })

  it('reports a failed write with its step and keeps the denial', async () => {
    const { ctx, clear } = setup(base(), { ok: false, step: 'pr', message: 'boom' })
    expect(await callAction(ctx, 'stage.allow', request)).toEqual({ kind: 'failed', step: 'pr', message: 'boom' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('answers unknown-denial for an id the dispatcher does not hold', async () => {
    const { ctx } = setup(base())
    expect(await callAction(ctx, 'stage.allow', { ...request, denialId: 'nope' })).toEqual({ kind: 'unknown-denial' })
  })
})

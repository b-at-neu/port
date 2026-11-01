import { describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReposListResponse } from '@/types/ipc'
import type { RegistryDeps } from '@/types/registry'
import type { StageChannelDeps } from '@/types/channels'
import type { AllowBaseRead, StageAllowIo, StageDenial } from '@/types/stage'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { resolveStageAllow } from '@/main/channels/stage'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'acme/widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: resolveVocabulary({}),
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: [],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

const DENIAL: StageDenial = { id: 'd1', repoId: REPO_ID, agent: 'plan', number: 480, toolName: 'Bash', inputSummary: 'pnpm test', rule: 'Bash(pnpm *)', at: '2026-01-01T00:00:00.000Z', sessionKey: null }
const HEAD = { oid: 'head', tree: 'tree' }
const CONFIG_TEXT = JSON.stringify({ extraAllow: [] })
const SETTINGS_TEXT = JSON.stringify({ permissions: { allow: [] } })

function base(overrides: Partial<Extract<AllowBaseRead, { ok: true }>> = {}): AllowBaseRead {
  return { ok: true, head: HEAD, settingsText: SETTINGS_TEXT, configText: CONFIG_TEXT, openPr: null, ...overrides }
}

function setup(read: AllowBaseRead, propose: StageAllowIo['propose'] = () => Promise.resolve({ ok: true, number: 7, url: 'https://github.com/acme/widgets/pull/7' })) {
  const clear = vi.fn()
  const readSpy = vi.fn((params: Parameters<StageAllowIo['read']>[0]) => {
    void params
    return Promise.resolve(read)
  })
  const proposeSpy = vi.fn(propose)
  const deps = {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] } as ReposListResponse),
    dispatcher: { status: () => [{ repoId: REPO_ID, denials: [DENIAL] }], clearDenialsFor: clear, dismissDenial: vi.fn() },
    auditDir: '/audit',
    scratchDir: '/tmp',
    allow: { read: readSpy, propose: proposeSpy },
  } as unknown as StageChannelDeps
  return { deps, clear, readSpy, proposeSpy }
}

const request = { repoId: REPO_ID, denialId: 'd1', rule: 'Bash(pnpm *)' }

describe('resolveStageAllow', () => {
  it('proposes a pull request and clears the rule from the denials', async () => {
    const { deps, clear, readSpy, proposeSpy } = setup(base())
    expect(await resolveStageAllow(registryDeps, request, deps)).toEqual({ kind: 'proposed', number: 7, url: 'https://github.com/acme/widgets/pull/7' })
    expect(readSpy.mock.calls[0]?.[0]).toMatchObject({ repo: { owner: 'acme', name: 'widgets' }, integration: 'dev' })
    expect(proposeSpy.mock.calls[0]?.[1]).toMatchObject({ head: HEAD, rule: 'Bash(pnpm *)', integration: 'dev' })
    expect(proposeSpy.mock.calls[0]?.[1].files.map((f) => f.path)).toEqual(['.claude/settings.json', '.claude/port.config.json'])
    expect(clear).toHaveBeenCalledWith(REPO_ID, 'Bash(pnpm *)')
  })

  it('reports already-proposed from an open pull request without writing', async () => {
    const { deps, clear, proposeSpy } = setup(base({ openPr: { number: 5, url: 'u' } }))
    expect(await resolveStageAllow(registryDeps, request, deps)).toEqual({ kind: 'already-proposed', number: 5, url: 'u' })
    expect(proposeSpy).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
  })

  it('reports already-allowed on integration and clears the stale denial', async () => {
    const { deps, clear, proposeSpy } = setup(base({ settingsText: JSON.stringify({ permissions: { allow: ['Bash(pnpm *)'] } }), configText: JSON.stringify({ extraAllow: ['Bash(pnpm *)'] }) }))
    expect(await resolveStageAllow(registryDeps, request, deps)).toEqual({ kind: 'already-allowed', integration: 'dev' })
    expect(proposeSpy).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
  })

  it('refuses an invalid rule before any read, keeping the denial', async () => {
    const { deps, clear, readSpy } = setup(base())
    expect(await resolveStageAllow(registryDeps, { ...request, rule: 'Bash' }, deps)).toEqual({ kind: 'invalid-rule', reason: 'unrestricted' })
    expect(readSpy).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('fails the read step and keeps the denial', async () => {
    const { deps, clear } = setup({ ok: false, message: 'rate limited' })
    expect(await resolveStageAllow(registryDeps, request, deps)).toEqual({ kind: 'failed', step: 'read', message: 'rate limited' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('fails the read step when a file on integration is not JSON', async () => {
    const { deps } = setup(base({ configText: '{' }))
    const result = await resolveStageAllow(registryDeps, request, deps)
    expect(result).toMatchObject({ kind: 'failed', step: 'read' })
  })

  it('reports a failed write with its step and keeps the denial', async () => {
    const { deps, clear } = setup(base(), () => Promise.resolve({ ok: false, step: 'pr', message: 'boom' }))
    expect(await resolveStageAllow(registryDeps, request, deps)).toEqual({ kind: 'failed', step: 'pr', message: 'boom' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('answers unknown-denial for an id the dispatcher does not hold', async () => {
    const { deps } = setup(base())
    expect(await resolveStageAllow(registryDeps, { ...request, denialId: 'nope' }, deps)).toEqual({ kind: 'unknown-denial' })
  })
})

import { describe, expect, it } from 'vitest'
import { runtimePreflight, runtimeProbe } from './preflight'
import type { RuntimeProbeDeps } from './preflight'
import type { RegistryDeps } from '../registry'
import type { RepoId } from '../../shared/repos'

const NOW = 1_700_000_000_000
const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by runtimeProbe')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: {} as never,
    commands: { worktrees: null },
  },
  diagnostics: [],
}

describe('runtimePreflight', () => {
  it('cli-missing when locate fails to find claude, and reads no version or credentials', async () => {
    let versionCalled = false
    let credentialsCalled = false
    const result = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'not-found', searched: ['/usr/bin/claude'] }),
      readClaudeVersion: () => {
        versionCalled = true
        return Promise.resolve({ ok: true, raw: '2.1.0', belowMinimum: false })
      },
      readCredentialsTell: () => {
        credentialsCalled = true
        return Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false })
      },
      env: {},
      platform: 'linux',
      now: () => NOW,
    })
    expect(result.diagnosis).toBe('cli-missing')
    expect(result.executable).toBeNull()
    expect(result.version).toBeNull()
    expect(result.credentials).toBeNull()
    expect(versionCalled).toBe(false)
    expect(credentialsCalled).toBe(false)
  })

  it('bundled-fallback carries the refused path in both executable and detail', async () => {
    const result = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'bundled-fallback', path: '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude' }),
      readClaudeVersion: () => Promise.resolve({ ok: true, raw: '2.1.0', belowMinimum: false }),
      readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
      env: {},
      platform: 'linux',
      now: () => NOW,
    })
    expect(result.diagnosis).toBe('bundled-fallback')
    expect(result.executable).toEqual({ path: '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude' })
    expect(result.detail).toBe('/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude')
  })

  it('cli-unusable when the version read fails, with version reported null', async () => {
    const result = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/usr/bin/claude' }),
      readClaudeVersion: () => Promise.resolve({ ok: false }),
      readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
      env: {},
      platform: 'linux',
      now: () => NOW,
    })
    expect(result.diagnosis).toBe('cli-unusable')
    expect(result.version).toBeNull()
  })

  it('#145: token-stale surfaces before any probe would run', async () => {
    const result = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/usr/bin/claude' }),
      readClaudeVersion: () => Promise.resolve({ ok: true, raw: '2.1.0', belowMinimum: false }),
      readCredentialsTell: () => Promise.resolve({ present: true, expiresAt: 0, hasRefreshToken: true }),
      env: {},
      platform: 'linux',
      now: () => NOW,
    })
    expect(result.diagnosis).toBe('token-stale')
  })

  it('a healthy install is unverified, carrying the resolved path and version', async () => {
    const result = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/home/operator/.local/bin/claude' }),
      readClaudeVersion: () => Promise.resolve({ ok: true, raw: '2.1.0', belowMinimum: false }),
      readCredentialsTell: () => Promise.resolve({ present: true, expiresAt: NOW + 100_000, hasRefreshToken: true }),
      env: {},
      platform: 'linux',
      now: () => NOW,
    })
    expect(result.diagnosis).toBe('unverified')
    expect(result.executable).toEqual({ path: '/home/operator/.local/bin/claude' })
    expect(result.version).toEqual({ raw: '2.1.0', belowMinimum: false })
  })

  it('reports apiKeyInEnvironment true only when ANTHROPIC_API_KEY is a non-empty string', async () => {
    const withKey = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'not-found', searched: [] }),
      readClaudeVersion: () => Promise.resolve({ ok: false }),
      readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
      env: { ANTHROPIC_API_KEY: 'sk-ant-dummy' },
      platform: 'linux',
      now: () => NOW,
    })
    expect(withKey.apiKeyInEnvironment).toBe(true)

    const withoutKey = await runtimePreflight({
      resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'not-found', searched: [] }),
      readClaudeVersion: () => Promise.resolve({ ok: false }),
      readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
      env: { ANTHROPIC_API_KEY: '' },
      platform: 'linux',
      now: () => NOW,
    })
    expect(withoutKey.apiKeyInEnvironment).toBe(false)
  })
})

function probeDeps(overrides: Partial<RuntimeProbeDeps>): RuntimeProbeDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
    resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/usr/bin/claude' }),
    readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
    probe: () => Promise.resolve({ diagnosis: 'verified', detail: null }),
    env: {},
    platform: 'linux',
    now: () => NOW,
    ...overrides,
  }
}

describe('runtimeProbe', () => {
  it('rejects a repository id that does not resolve', async () => {
    await expect(runtimeProbe({ registryDeps, repoId: REPO_ID }, probeDeps({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) }))).rejects.toThrow(
      `'runtime:probe' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects a repository that is not ready', async () => {
    const notReady = { id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }
    await expect(runtimeProbe({ registryDeps, repoId: REPO_ID }, probeDeps({ listRepositories: () => Promise.resolve({ ok: true, repositories: [notReady] }) }))).rejects.toThrow(
      "'runtime:probe' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('names the resolved repository, even on a locate failure', async () => {
    const result = await runtimeProbe(
      { registryDeps, repoId: REPO_ID },
      probeDeps({ resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'not-found', searched: [] }) }),
    )
    expect(result.repo).toBe('acme/widgets')
    expect(result.diagnosis).toBe('cli-missing')
  })

  it('never calls the probe when locate fails', async () => {
    let probeCalled = false
    await runtimeProbe(
      { registryDeps, repoId: REPO_ID },
      probeDeps({
        resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'not-found', searched: [] }),
        probe: () => {
          probeCalled = true
          return Promise.resolve({ diagnosis: 'verified', detail: null })
        },
      }),
    )
    expect(probeCalled).toBe(false)
  })

  it('a successful probe reports verified and elapsed time', async () => {
    const result = await runtimeProbe({ registryDeps, repoId: REPO_ID }, probeDeps({}))
    expect(result.diagnosis).toBe('verified')
    expect(result.detail).toBeNull()
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('carries the api key flag through to the probe response', async () => {
    const result = await runtimeProbe({ registryDeps, repoId: REPO_ID }, probeDeps({ env: { ANTHROPIC_API_KEY: 'sk-ant-dummy' } }))
    expect(result.apiKeyInEnvironment).toBe(true)
  })
})

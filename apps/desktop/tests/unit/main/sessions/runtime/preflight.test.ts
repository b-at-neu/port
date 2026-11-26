import { describe, expect, it } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import type { HostedQueryFn } from '@/main/platform/sdk'
import { runtimePreflight, runtimeProbe } from '@/main/sessions/runtime/preflight'
import type { CommandResult, WhichResult } from '@/types/platform'
import type { RuntimePreflight } from '@/types/runtime'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { createFakePlatform, fakeRun, fakeSdk, fakeWhich } from '../../../../support/fake-platform'
import { createTestContext } from '../../../../support/context'
import { readyEntry } from '../../../../support/repo-config'

const REPO_ID = 'repo-1' as RepoId
const PROBE_DIR = '/userdata/runtime-probe'
const CLAUDE = '/usr/bin/claude'
const BUNDLED = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'

const FOUND: WhichResult = { ok: true, path: CLAUDE }
const MISSING: WhichResult = { ok: false, kind: 'not-found', command: 'claude', searched: [CLAUDE] }
const printed = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: '' })
const UNUSABLE: CommandResult = { ok: false, kind: 'not-found', command: 'claude', searched: [] }
const credentials = (expiresAt: number) => ({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt } })

describe('runtimePreflight', () => {
  it.each<{
    readonly name: string
    readonly which: WhichResult
    readonly run?: CommandResult
    readonly credentials?: unknown
    readonly env?: Record<string, string>
    readonly expected: Partial<RuntimePreflight>
  }>([
    { name: 'cli-missing when claude is not found, reading no version or credentials', which: MISSING, expected: { diagnosis: 'cli-missing', executable: null, version: null, credentials: null } },
    { name: 'bundled-fallback carries the refused path in both executable and detail', which: { ok: true, path: BUNDLED }, expected: { diagnosis: 'bundled-fallback', executable: { path: BUNDLED }, detail: BUNDLED } },
    { name: 'cli-unusable when the version read fails, with version reported null', which: FOUND, run: UNUSABLE, expected: { diagnosis: 'cli-unusable', version: null } },
    { name: '#677: an expired access token with a refresh token is unverified, never token-stale', which: FOUND, run: printed('9.9.9\n'), credentials: credentials(0), expected: { diagnosis: 'unverified' } },
    {
      name: 'a healthy install is unverified, carrying the resolved path and version',
      which: FOUND,
      run: printed('9.9.9\n'),
      credentials: credentials(4_102_444_800_000),
      expected: { diagnosis: 'unverified', executable: { path: CLAUDE }, version: { raw: '9.9.9', belowMinimum: false } },
    },
    { name: 'reports apiKeyInEnvironment for a non-empty ANTHROPIC_API_KEY', which: MISSING, env: { ANTHROPIC_API_KEY: 'sk-ant-dummy' }, expected: { apiKeyInEnvironment: true } },
    { name: 'reports no apiKeyInEnvironment for an empty ANTHROPIC_API_KEY', which: MISSING, env: { ANTHROPIC_API_KEY: '' }, expected: { apiKeyInEnvironment: false } },
  ])('$name', async ({ which, run, credentials: tell, env, expected }) => {
    const platform = createFakePlatform()
    if (tell !== undefined) await platform.fs.writeJsonAtomic(pathOps.join(platform.claudeHome, '.credentials.json'), tell)
    const ctx = { ...platform, which: fakeWhich(() => Promise.resolve(which)), run: fakeRun(run === undefined ? undefined : () => Promise.resolve(run)), env: env ?? {} }
    expect(await runtimePreflight(ctx)).toMatchObject(expected)
  })
})

describe('runtimeProbe', () => {
  async function* verdict() {
    await Promise.resolve()
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }
  }
  const verified = (() => verdict()) as unknown as HostedQueryFn

  function probeContext(options: { readonly repositories?: readonly RepositoryEntry[]; readonly which?: WhichResult; readonly query?: HostedQueryFn; readonly env?: Record<string, string> } = {}) {
    return createTestContext({
      repositories: options.repositories ?? [readyEntry({ id: REPO_ID }, { repo: 'acme/widgets' })],
      platform: { which: fakeWhich(() => Promise.resolve(options.which ?? FOUND)), sdk: fakeSdk({ query: options.query ?? verified }), env: options.env ?? {} },
    })
  }

  it.each([
    { name: 'a repository id that does not resolve', repositories: [], message: `'runtime:probe' no repository is registered with id '${REPO_ID}'` },
    {
      name: 'a repository that is not ready',
      repositories: [{ id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }],
      message: `'runtime:probe' repository '${REPO_ID}' is 'directory-missing', not ready`,
    },
  ])('rejects $name', async ({ repositories, message }) => {
    await expect(runtimeProbe(probeContext({ repositories }), { repoId: REPO_ID, probeDir: PROBE_DIR })).rejects.toThrow(message)
  })

  it.each([
    { name: 'a successful probe reports verified', which: FOUND, expected: { repo: 'acme/widgets', diagnosis: 'verified', detail: null } },
    { name: 'a missing executable still names the resolved repository', which: MISSING, expected: { repo: 'acme/widgets', diagnosis: 'cli-missing' } },
    { name: 'the bundled binary is refused, naming its path', which: { ok: true, path: BUNDLED } as WhichResult, expected: { diagnosis: 'bundled-fallback', detail: BUNDLED } },
  ])('with a repository, $name', async ({ which, expected }) => {
    const result = await runtimeProbe(probeContext({ which }), { repoId: REPO_ID, probeDir: PROBE_DIR })
    expect(result).toMatchObject(expected)
  })

  it('carries the api key flag through to the probe response', async () => {
    const result = await runtimeProbe(probeContext({ env: { ANTHROPIC_API_KEY: 'sk-ant-dummy' } }), { repoId: REPO_ID, probeDir: PROBE_DIR })
    expect(result.apiKeyInEnvironment).toBe(true)
  })

  describe('repository-free mode (repoId: null)', () => {
    it('creates the probe directory, runs the turn there and names no repository, without reading the registry', async () => {
      let cwdUsed: string | undefined
      const query = ((params: { options?: { cwd?: string } }) => {
        cwdUsed = params.options?.cwd
        return verified(params as never)
      }) as unknown as HostedQueryFn
      const ctx = createTestContext({
        platform: { which: fakeWhich(() => Promise.resolve(FOUND)), sdk: fakeSdk({ query }), env: {} },
        repos: {
          resolve: () => {
            throw new Error('the registry must not be read')
          },
        },
      })

      const result = await runtimeProbe(ctx, { repoId: null, probeDir: PROBE_DIR })

      expect(result).toMatchObject({ repo: null, diagnosis: 'verified' })
      expect(cwdUsed).toBe(PROBE_DIR)
      expect(await ctx.fs.exists(PROBE_DIR)).toBe(true)
    })

    it('a missing executable still returns cli-missing, never throws', async () => {
      const result = await runtimeProbe(probeContext({ which: MISSING }), { repoId: null, probeDir: PROBE_DIR })
      expect(result).toMatchObject({ diagnosis: 'cli-missing', repo: null })
    })
  })
})

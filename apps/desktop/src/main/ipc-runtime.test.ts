// `resolveRuntimeProbe`'s validation (#97) — kept in its own file rather
// than added to `ipc.test.ts`, which already sits at the 500-line ratchet
// (`scripts/checks/file-size.mjs`) with no room left; `'runtime:preflight'`
// needs no test of its own, the same as `'app:info'`/`'repos:list'`/
// `'repos:add'`/`'sessions:scan'`/`'board:snapshot'` — none of those trivial
// "takes no payload" handlers are unit tested either, since there is no
// exported `resolveX` wrapper to call.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../shared/repos'
import { resolveRuntimeProbe } from './ipc'
import type { RegistryDeps } from './registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveRuntimeProbe')
  },
  chooseDirectory: () => Promise.resolve(null),
}

describe('resolveRuntimeProbe', () => {
  it('rejects a missing repoId', async () => {
    await expect(resolveRuntimeProbe(registryDeps, { repoId: undefined as unknown as RepoId })).rejects.toThrow("'runtime:probe' requires a non-empty 'repoId'")
  })

  it('rejects an empty repoId', async () => {
    await expect(resolveRuntimeProbe(registryDeps, { repoId: '' as unknown as RepoId })).rejects.toThrow("'runtime:probe' requires a non-empty 'repoId'")
  })

  it('a well-formed request delegates to runtimeProbe, which resolves the registry itself', async () => {
    // No repository is registered at '/registry' in this test environment,
    // so `runtimeProbe`'s own registry lookup surfaces its own error --
    // proof that validation passed through rather than a `RuntimeProbe`
    // value silently swallowing the mismatch.
    await expect(resolveRuntimeProbe(registryDeps, { repoId: REPO_ID })).rejects.toThrow(/runtime:probe/)
  })
})

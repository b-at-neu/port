// Kept in its own file rather than added to `ipc.test.ts`, which sits at the 500-line ratchet
// with no room left.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../shared/repos'
import { resolveRuntimeProbe } from './channels/runtime'
import type { RegistryDeps } from './registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveRuntimeProbe')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const PROBE_DIR = '/userdata/runtime-probe'

describe('resolveRuntimeProbe', () => {
  it('rejects a missing repoId', async () => {
    await expect(resolveRuntimeProbe(registryDeps, { repoId: undefined as unknown as RepoId }, PROBE_DIR)).rejects.toThrow("'runtime:probe' requires 'repoId' to be a non-empty string or null")
  })

  it('rejects an empty repoId', async () => {
    await expect(resolveRuntimeProbe(registryDeps, { repoId: '' as unknown as RepoId }, PROBE_DIR)).rejects.toThrow("'runtime:probe' requires 'repoId' to be a non-empty string or null")
  })

  it('rejects a non-string, non-null repoId', async () => {
    await expect(resolveRuntimeProbe(registryDeps, { repoId: 1 as unknown as RepoId }, PROBE_DIR)).rejects.toThrow("'runtime:probe' requires 'repoId' to be a non-empty string or null")
  })

  it('a well-formed request delegates to runtimeProbe, which resolves the registry itself', async () => {
    // No repository is registered here, so `runtimeProbe`'s own registry lookup surfaces its own error.
    await expect(resolveRuntimeProbe(registryDeps, { repoId: REPO_ID }, PROBE_DIR)).rejects.toThrow(/runtime:probe/)
  })

  it('an explicit null repoId never touches the registry', async () => {
    const result = await resolveRuntimeProbe(registryDeps, { repoId: null }, PROBE_DIR)
    expect(result.repo).toBeNull()
  })
})

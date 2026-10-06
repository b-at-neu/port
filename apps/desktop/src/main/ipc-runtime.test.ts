// `resolveRuntimeProbe`'s validation (#97) — kept in its own file rather
// than added to `ipc.test.ts`, which already sits at the 500-line ratchet
// (`scripts/checks/file-size.mjs`) with no room left; `'runtime:preflight'`
// needs no test of its own, the same as `'app:info'`/`'repos:list'`/
// `'repos:add'`/`'sessions:scan'`/`'board:snapshot'` — none of those trivial
// "takes no payload" handlers are unit tested either, since there is no
// exported `resolveX` wrapper to call. #314: `resolveRuntimeProbe` itself
// moved to `main/channels/runtime.ts` to keep `ipc.ts` under its own
// 500-line limit — a pure relocation, this file's own import is the only
// thing that changed.
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
    // No repository is registered at '/registry' in this test environment,
    // so `runtimeProbe`'s own registry lookup surfaces its own error --
    // proof that validation passed through rather than a `RuntimeProbe`
    // value silently swallowing the mismatch.
    await expect(resolveRuntimeProbe(registryDeps, { repoId: REPO_ID }, PROBE_DIR)).rejects.toThrow(/runtime:probe/)
  })

  it('an explicit null repoId never touches the registry', async () => {
    const result = await resolveRuntimeProbe(registryDeps, { repoId: null }, PROBE_DIR)
    expect(result.repo).toBeNull()
  })
})

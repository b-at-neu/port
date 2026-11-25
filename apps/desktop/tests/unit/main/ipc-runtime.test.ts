// Kept in its own file rather than added to `ipc.test.ts`, which sits at the 500-line ratchet
// with no room left.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { resolveRuntimeProbe } from '@/main/features/runtime/resolve'
import { fakeWhich } from '../../support/fake-platform'
import { createTestContext } from '../../support/context'

const REPO_ID = 'repo-1' as RepoId
const PROBE_DIR = '/userdata/runtime-probe'

const ctx = () => createTestContext({ platform: { which: fakeWhich(() => Promise.resolve({ ok: false, kind: 'not-found', command: 'claude', searched: [] })), env: {} } })

describe('resolveRuntimeProbe', () => {
  it.each([
    { name: 'a missing repoId', repoId: undefined },
    { name: 'an empty repoId', repoId: '' },
    { name: 'a non-string, non-null repoId', repoId: 1 },
  ])('rejects $name', async ({ repoId }) => {
    await expect(resolveRuntimeProbe(ctx(), { repoId: repoId as unknown as RepoId }, PROBE_DIR)).rejects.toThrow("'runtime:probe' requires 'repoId' to be a non-empty string or null")
  })

  it('a well-formed request delegates to runtimeProbe, which resolves the registry itself', async () => {
    // No repository is registered here, so `runtimeProbe`'s own registry lookup surfaces its own error.
    await expect(resolveRuntimeProbe(ctx(), { repoId: REPO_ID }, PROBE_DIR)).rejects.toThrow(/runtime:probe/)
  })

  it('an explicit null repoId never touches the registry', async () => {
    const result = await resolveRuntimeProbe(ctx(), { repoId: null }, PROBE_DIR)
    expect(result.repo).toBeNull()
  })
})

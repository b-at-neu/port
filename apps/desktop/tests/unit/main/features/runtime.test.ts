import { describe, expect, it } from 'vitest'
import { fakeWhich } from '../../../support/fake-platform'
import { callAction, createTestContext } from '../../../support/context'

const ctx = () => createTestContext({ platform: { which: fakeWhich(() => Promise.resolve({ ok: false, kind: 'not-found', command: 'claude', searched: [] })), env: {} } })

describe('runtime.probe', () => {
  it('a null repoId never touches the registry', async () => {
    const result = await callAction(ctx(), 'runtime.probe', { repoId: null })
    expect(result.repo).toBeNull()
  })

  it('an unregistered repoId surfaces the registry lookup failure', async () => {
    await expect(callAction(ctx(), 'runtime.probe', { repoId: 'repo-1' as never })).rejects.toThrow()
  })
})

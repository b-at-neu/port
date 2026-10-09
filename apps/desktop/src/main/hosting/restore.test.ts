import { describe, expect, it } from 'vitest'
import { dropAdopted, mintRestorable, nextPersisted, persistedOpen } from './restore'
import type { HostedSessionSnapshot, SessionKey } from '../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../shared/hosting/controls'
import type { RepoId } from '../../shared/repos'

const REPO_ID = 'repo-1' as RepoId

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'session-1',
    repoId: REPO_ID,
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00.000Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: 'Fix the thing',
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
    ...overrides,
  }
}

describe('persistedOpen', () => {
  it('includes a live handle with a real claudeSessionId', () => {
    expect(persistedOpen([snapshot()])).toEqual([{ repoId: REPO_ID, claudeSessionId: 'session-1', title: 'Fix the thing', startedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('excludes a handle with no claudeSessionId yet', () => {
    expect(persistedOpen([snapshot({ claudeSessionId: null })])).toEqual([])
  })

  it('excludes closing and ended handles', () => {
    expect(persistedOpen([snapshot({ phase: 'closing' }), snapshot({ phase: 'ended' })])).toEqual([])
  })
})

describe('mintRestorable', () => {
  it('assigns restore-<n> ids by position', () => {
    const entries = [
      { repoId: REPO_ID, claudeSessionId: 'a', title: null, startedAt: 't1' },
      { repoId: REPO_ID, claudeSessionId: 'b', title: null, startedAt: 't2' },
    ]
    expect(mintRestorable(entries).map((entry) => entry.restoreId)).toEqual(['restore-1', 'restore-2'])
  })
})

describe('dropAdopted', () => {
  it('removes the entry matching the adopted claudeSessionId', () => {
    const restorable = mintRestorable([{ repoId: REPO_ID, claudeSessionId: 'a', title: null, startedAt: 't1' }])
    expect(dropAdopted(restorable, 'a')).toEqual([])
  })

  it('leaves other entries untouched', () => {
    const restorable = mintRestorable([
      { repoId: REPO_ID, claudeSessionId: 'a', title: null, startedAt: 't1' },
      { repoId: REPO_ID, claudeSessionId: 'b', title: null, startedAt: 't2' },
    ])
    expect(dropAdopted(restorable, 'a').map((entry) => entry.claudeSessionId)).toEqual(['b'])
  })
})

describe('nextPersisted', () => {
  it('is the live set plus every not-yet-adopted restorable entry', () => {
    const live = [{ repoId: REPO_ID, claudeSessionId: 'a', title: 'A', startedAt: 't1' }]
    const restorable = mintRestorable([{ repoId: REPO_ID, claudeSessionId: 'b', title: 'B', startedAt: 't2' }])
    expect(nextPersisted({ limit: 4, live, restorable })).toEqual({
      limit: 4,
      open: [
        { repoId: REPO_ID, claudeSessionId: 'a', title: 'A', startedAt: 't1' },
        { repoId: REPO_ID, claudeSessionId: 'b', title: 'B', startedAt: 't2' },
      ],
    })
  })

  it('dedupes by claudeSessionId with the live entry winning', () => {
    const live = [{ repoId: REPO_ID, claudeSessionId: 'a', title: 'Live title', startedAt: 't1' }]
    const restorable = mintRestorable([{ repoId: REPO_ID, claudeSessionId: 'a', title: 'Stale title', startedAt: 't0' }])
    expect(nextPersisted({ limit: 4, live, restorable })).toEqual({ limit: 4, open: [{ repoId: REPO_ID, claudeSessionId: 'a', title: 'Live title', startedAt: 't1' }] })
  })
})

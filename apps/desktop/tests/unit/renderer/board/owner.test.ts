// `ownershipBannerFor` — the one owner state the Board banners, and the owners that get none.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { RepoDispatchStatus } from '@/types/dispatch'
import { ownershipBannerFor } from '@/renderer/board/owner'

const REPO_ID = 'repo-a' as RepoId

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

describe('ownershipBannerFor', () => {
  it('unreadable names the repository, the reason, and that neither side runs it', () => {
    const message = ownershipBannerFor(status({ owner: 'unreadable', unreadableMessage: 'invalid JSON' }), 'o/a')
    expect(message).toContain("o/a — .agents/cockpit.json can't be read (invalid JSON)")
    expect(message).toContain('Neither this app nor a terminal cockpit runs this repo')
  })

  it('unreadable falls back to an unknown reason', () => {
    expect(ownershipBannerFor(status({ owner: 'unreadable' }), 'o/a')).toContain('(unknown reason)')
  })

  it('app and none need nothing from the operator', () => {
    expect(ownershipBannerFor(status({ owner: 'app' }), 'o/a')).toBeNull()
    expect(ownershipBannerFor(status({ owner: 'none' }), 'o/a')).toBeNull()
  })
})
